const Moralis = require('@moralisweb3/common-sol-utils');

Moralis.start({
  apiKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjA5OTU0ZjMzLTgzZmQtNDMwNi04NmM4LTM4YWRkNTExOWZhNSIsIm9yZ0lkIjoiNDQzNDcyIiwidXNlcklkIjoiNDU2Mjc3IiwidHlwZUlkIjoiMTQxMDQ0OGMtMWExYi00YWE5LWI2ZTktMzY0NjVjZWQ3ZjNlIiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NDU0MzA0MTUsImV4cCI6NDkwMTE5MDQxNX0._FBd994Mzl79I46_VHyRkpwJ1J19zEG5mDpsQHfeEIs',
});

async function testMoralis() {
  try {
    const response = await Moralis.SolApi.token.getTokenPrice({
      network: 'mainnet',
      address: 'Grb4QcXy5hscB5Dq6S9DVJ6cvg3wLJtieMW7cYFcpump',
    });
    console.log('Moralis Response:', JSON.stringify(response.raw, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testMoralis();
