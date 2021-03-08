import { ethers } from "ethers";
import ganache = require("ganache-core");

// Spin up two instances of ganache.
// Deploy NitroAdjudicator, ETHAssetHolder, HashLock to both instances
// Run an atomic swap between the chains (Happy Case, Direct Funding)
// Record time taken and gas consumed
// Explore unhappy cases
// Explore off-chain funding use case

// const provider = new ethers.providers.Web3Provider(ganache.provider());

const left = {
  port: 9001,
  _chainId: 66,
  _chainIdRpc: 66,
};
const leftServer = (ganache as any).server(left);
leftServer.listen(left.port, async (err) => {
  if (err) throw err;
  console.log(`ganache listening on port ${left.port}...`);
});
const leftChain = new ethers.providers.JsonRpcProvider(
  `http://localhost:${left.port}`
);

const right = {
  port: 9002,
  _chainId: 66,
  _chainIdRpc: 66,
};
const rightServer = (ganache as any).server(right);
rightServer.listen(right.port, async (err) => {
  if (err) throw err;
  console.log(`ganache listening on port ${right.port}...`);
});
const rightChain = new ethers.providers.JsonRpcProvider(
  `http://localhost:${right.port}`
);

(async function () {
  console.log(await leftChain.getBlockNumber());
  console.log(await rightChain.getBlockNumber());
  await leftServer.close();
  await rightServer.close();
})();
