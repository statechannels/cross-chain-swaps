import { ethers } from "ethers";
import ganache = require("ganache-core");
import { LEFT_CHAIN_ID, RIGHT_CHAIN_ID } from "./constants";

export function spinUpChains() {
  const executorWallet = ethers.Wallet.createRandom();
  const responderWallet = ethers.Wallet.createRandom();
  const deployerWallet = ethers.Wallet.createRandom(); // to deploy contracts

  const left = {
    gasPrice: ethers.constants.One.toHexString(),
    port: 9001,
    _chainId: LEFT_CHAIN_ID,
    _chainIdRpc: LEFT_CHAIN_ID,
    accounts: [
      {
        secretKey: executorWallet.privateKey,
        balance: ethers.constants.WeiPerEther.mul(800).toHexString(),
      },
      {
        secretKey: deployerWallet.privateKey,
        balance: ethers.constants.WeiPerEther.mul(800).toHexString(),
      },
    ],
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
    gasPrice: ethers.constants.One.toHexString(),
    port: 9002,
    _chainId: RIGHT_CHAIN_ID,
    _chainIdRpc: RIGHT_CHAIN_ID,
    accounts: [
      {
        secretKey: responderWallet.privateKey,
        balance: ethers.constants.WeiPerEther.mul(800).toHexString(),
      },
      {
        secretKey: deployerWallet.privateKey,
        balance: ethers.constants.WeiPerEther.mul(800).toHexString(),
      },
    ],
  };
  const rightServer = (ganache as any).server(right);
  rightServer.listen(right.port, async (err) => {
    if (err) throw err;
    console.log(`ganache listening on port ${right.port}...`);
  });
  const rightChain = new ethers.providers.JsonRpcProvider(
    `http://localhost:${right.port}`
  );

  async function tearDownChains() {
    await leftServer.close();
    await rightServer.close();
  }
  return {
    executorWallet,
    responderWallet,
    deployerWallet,
    leftChain,
    rightChain,
    tearDownChains,
  };
}
