/** @flow */
import serverlessIndex from './serverless-index';
import indexer from './indexer';
import type Doc from './indexer';

const boost = {
  box: 3,
  tokenizedBox: 2,
  name: 5,
  tokenizedName: 4,
  functionNames: 2,
  tokenizedFunctionNames: 2,
  minDescription: 1
};

function totalHits(index: Promise<any>, query: string) {
  return new Promise((resolve, reject) => {
    return index.then((indexInstance) => {
      indexInstance.totalHits({
        query: buildQuery(query)
      }, (err, count) => {
        if (err) reject(err);
        resolve(JSON.stringify(count));
      });
    });
  });
}

function countDocs(index: Promise<any>) {
  return new Promise((resolve, reject) => {
    return index.then((indexInstance) => {
      indexInstance.countDocs((err, info) => {
        if (err) reject(err);
        resolve(info);
      });
    });
  });
}

function getDoc(index: Promise<any>, docIds: string[]) {
  return new Promise((resolve, reject) => {
    return index.then((indexInstance) => {
      indexInstance.get(docIds).on('data', function (doc) {
        console.log(doc);
      });
    });
  });
}

function formatSearchResult(doc: Doc): string {
  return `> ${doc.box}/${doc.name}`;
}

function queryItem(field, queryStr): Object {
  const query = {
    AND: { [field]: queryStr.toLowerCase().split(' ') },
    BOOST: boost[field],
    NOT: {}
  };
  
  return query;
}

function buildQuery(queryStr: string): Array<Object> {
  const tokenizedQuery = indexer.tokenizeStr(queryStr);
  const query = [];
  query.push(queryItem('box', queryStr));
  query.push(queryItem('tokenizedBox', queryStr));
  query.push(queryItem('name', queryStr));
  query.push(queryItem('tokenizedName', tokenizedQuery));
  query.push(queryItem('functionNames', queryStr));
  query.push(queryItem('tokenizedFunctionNames', tokenizedQuery));
  query.push(queryItem('minDescription', queryStr));
  return query;
}

function search(queryStr: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const index = serverlessIndex.initializeIndex(path);
    const searchResults = [];
    const query = buildQuery(queryStr);
    return index.then((indexInstance) => {
      indexInstance.search({
        query,
      }).on('data', function (data) {
        searchResults.push(formatSearchResult(data.document));
      }).on('end', function () {
          return resolve(JSON.stringify(searchResults));
        });
    });
  });
}

module.exports = {
  search,
};