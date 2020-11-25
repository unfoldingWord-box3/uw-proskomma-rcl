const Axios = require("axios");
const YAML = require('js-yaml-parser');
const fse = require('fs-extra');
const deepcopy = require('deepcopy');

const {UWProsKomma} = require('../index');

const getDocuments = async pk => {
    const baseURLs = [
        // ["rus", "ru_gl", "https://git.door43.org/ru_gl/ru_rlob/raw/branch/master"],
        ["unfoldingWord", "grc", "ugnt", "https://git.door43.org/unfoldingWord/el-x-koine_ugnt/raw/branch/master"],
        ["unfoldingWord", "en", "ust", "https://git.door43.org/unfoldingWord/en_ust/raw/branch/master"],
        ["unfoldingWord", "en", "ult", "https://git.door43.org/unfoldingWord/en_ult/raw/branch/master"]
    ];
    console.log("Download USFM");
    for (const [org, lang, abbr, baseURL] of baseURLs) {
        const selectors = {
            org,
            lang,
            abbr
        };
        console.log(`  ${org}/${lang}/${abbr}`)
        const content = [];
        await Axios.request(
            {method: "get", "url": `${baseURL}/manifest.yaml`}
        )
            .then(
                async response => {
                    const manifest = YAML.safeLoad(response.data);
                    const bookPaths = manifest.projects.map(e => e.path.split("/")[1]);
                    for (const bookPath of bookPaths) {
                        const pathBook = bookPath.split(".")[0].split('-')[1];
                        if (pathBook !== book) {
                            continue;
                        }
                        console.log(`    ${pathBook}`)
                        try {
                            await Axios.request(
                                {method: "get", "url": `${baseURL}/${bookPath}`}
                            )
                                .then(response => {
                                    content.push(response.data);
                                })
                        } catch (err) {
                            console.log(`Could not load ${bookPath} for ${lang}/${abbr}`);
                        }
                    }
                }
            );
        console.log(`      Downloaded`)
        const startTime = Date.now();
        pk.importDocuments(selectors, "usfm", content, {});
        console.log(`      Imported in ${Date.now() - startTime} msec`);
    }
    return pk;
}

const tsvRowToObject = entry => {
    const [n, row] = entry;
    return {
        n: n,
        book: row[0],
        chapter: row[1],
        verse: row[2],
        id: row[3],
        supportReference: row[4],
        origQuote: row[5],
        occurrence: row[6],
        glQuote: row[7],
        occurrenceNote: row[8]
    }
}

const readTsv = path => {
    console.log("Read TSV");
    const tsvEntries = fse.readFileSync(tsvPath)
        .toString()
        .split("\n")
        .map(r => r.split("\t"))
        .entries();
    const tsvObjects = [...tsvEntries]
        .map(r => tsvRowToObject(r))
        .filter(r => r.origQuote && parseInt(r.chapter) > 0);
    return tsvObjects;
}

const searchWordRecords = origString => {
    const ret = [];
    for (let searchExpr of origString.split(" ")) {
        searchExpr = searchExpr.replace(/[,’?;.!]/g, "");
        if (searchExpr.includes("…")) {
            const searchExprParts = searchExpr.split("…");
            ret.push([searchExprParts[0], false]);
            searchExprParts.slice(1).forEach(p => ret.push([p, true]));
        } else {
            ret.push([searchExpr, false]);
        }
    }
    return ret;
}

const doQuery = async () => {
    const query = ('{' +
        'docSets {' +
        '  abbr: selector(id:"abbr")' +
        '  documents {' +
        '    book: header(id:"bookCode")' +
        '    mainSequence {' +
        '      itemGroups (' +
        '        byScopes:["chapter/", "verse/"]' +
        '        includeContext:true' +
        '      ) {' +
        '        scopeLabels' +
        '        tokens {' +
        '          subType' +
        '          chars' +
        '          position' +
        '          scopes(startsWith:["attribute/milestone/zaln/x-lemma", "attribute/spanWithAtts/w/lemma", ])' +
        '        }' +
        '      }' +
        '    }' +
        '  }' +
        '}' +
        '}');
    let startTime = Date.now();
    const result = await pk.gqlQuery(query);
    console.log(`GraphQL query in ${Date.now() - startTime} msec`);
    if (result.errors) {
        throw new Error(result.errors);
    }
    startTime = Date.now();
    const ret = {};
    for (const docSet of result.data.docSets) {
        ret[docSet.abbr] = {};
        for (const document of docSet.documents) {
            ret[docSet.abbr][document.book] = {};
            for (const itemGroup of document.mainSequence.itemGroups) {
                const chapter = itemGroup.scopeLabels.filter(s => s.startsWith("chapter/"))[0].split("/")[1];
                const verse = itemGroup.scopeLabels.filter(s => s.startsWith("verse/"))[0].split("/")[1];
                const cv = `${chapter}:${verse}`;
                ret[docSet.abbr][document.book][cv] = itemGroup.tokens;
            }
        }
    }
    console.log(`Postprocess Query Result in ${Date.now() - startTime} msec`);
    return ret;
}

const slimTokens = tokens => {
    if (!tokens) {
        return null;
    }
    return tokens
        .filter(t => t.subType === "wordLike")
        .map(t => {
            const t2 = deepcopy(t);
            t2.lemma = t2.scopes.map(s => s.split("/")[5]);
            delete t2.scopes;
            delete t2.subType;
            return t2;
        })
}

const lemmaForSearchWords = (searchTuples, tokens) => {

    const lfsw1 = (searchTuples, tokens, lemma) => {
        if (!lemma) {
            lemma = [];
        }
        if (searchTuples.length === 0) { // Everything matched
            return lemma;
        } else if (tokens.length === 0) { // No more tokens - fail
            return null;
        } else if (tokens[0].chars === searchTuples[0][0]) { // First word matched, try next one
            return lfsw1(searchTuples.slice(1), tokens.slice(1), lemma.concat(tokens[0].lemma));
        } else if (searchTuples[0][1]) { // non-greedy wildcard, try again on next token
            return lfsw1(searchTuples, tokens.slice(1), lemma.concat(tokens[0].lemma));
        } else { // No wildcard and no match - fail
            return null;
        }
    }

    if (tokens.length === 0) {
        return null;
    }
    return lfsw1(searchTuples, tokens) || lemmaForSearchWords(searchTuples, tokens.slice(1));
}

const glTextForLemma = (tokens, lemmaTuples) => {

    const gltfl1 = (tokens, lemmaTuples, glWords) => {
        if (!glWords) {
            glWords = [];
        }
        if (tokens.length === 0) { // End of tokens
            if (lemmaTuples.filter(lt => !lt[1]).length === 0) { // Every lemma matched once - success!
                return glWords;
            } else {
                return null;
            }
        } else if (!tokens[0].lemma) { // No lemmas for first token - try next token
            return gltfl1(tokens.slice(1), lemmaTuples, glWords.concat([tokens[0].chars]));
        } else { // Try to match lemmaTuples to lemma for first Token
            let matched = false;
            for (const tokenLemma of tokens[0].lemma) {
                for (const lemmaTuple of lemmaTuples) {
                    if (tokenLemma === lemmaTuple[0]) {
                        lemmaTuple[1] = true;
                        matched = true;
                    }
                }
            }
            if (matched) { // Matched token and updated at least one lemma flag - next token please!
                return gltfl1(tokens.slice(1), lemmaTuples, glWords.concat([tokens[0].chars]));
            } else { // No match - success or fail
                if (lemmaTuples.filter(lt => !lt[1]).length === 0) { // Every lemma matched once - success!
                    return glWords;
                } else {
                    return null;
                }
            }
        }
    }

    if (tokens.length === 0) {
        return null;
    }
    return gltfl1(tokens, lemmaTuples) || glTextForLemma(tokens.slice(1), lemmaTuples);
}


// MAIN
const pk = new UWProsKomma();
const args = process.argv.slice(2);
const tsvPath = args[0];
const book = tsvPath.split(".")[0].split("-")[1];

getDocuments(pk)
    .then(async () => {
            const startTime = Date.now();
            const tokenLookup = await doQuery(book);
            console.log("Iterate over TSV records");
            let nRecords = 0;
            for (const tsvRecord of readTsv(tsvPath)) {
                nRecords++;
                const cv = `${tsvRecord.chapter}:${tsvRecord.verse}`;
                console.log(`  ${tsvRecord.book} ${cv}`);
                console.log(`    Search string: ${tsvRecord.origQuote}`);
                const searchTuples = searchWordRecords(tsvRecord.origQuote);
                const ugntTokens = slimTokens(tokenLookup.ugnt[book][cv]);
                const lemma = lemmaForSearchWords(searchTuples, ugntTokens);
                if (!lemma) {
                    console.log(`    NO LEMMA MATCHED`);
                    console.log(`    SEARCH TUPLES: ${JSON.stringify(searchTuples)}`)
                    continue;
                }
                console.log(`    Lemma for match: ${lemma.join(" ")}`);
                for (const gl of ["ult", "ust"]) {
                    const glTokens = slimTokens(tokenLookup[gl][book][cv]);
                    if (!glTokens) {
                        console.log(`    NO TOKENS for ${gl}`);
                        continue;
                    }
                    const glText = glTextForLemma(glTokens, lemma.map(l => [l, false]));
                    if (!glText) {
                        console.log(`    NO GL TEXT MATCHED`);
                        continue;
                    }
                    console.log(`    ${gl}: "${glText.join(" ")}"`);
                }
                console.log();
            }
            console.log(`${nRecords} rows processed in ${Date.now() - startTime} msec`);
        }
    )