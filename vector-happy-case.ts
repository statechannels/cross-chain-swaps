import { BigNumber, Contract, ContractFactory, ethers } from "ethers";
import ganache = require("ganache-core");
import chalk = require("chalk");
import { artifacts } from "@connext/vector-contracts";

// Spin up two instances of ganache.
// Deploy NitroAdjudicator, ETHAssetHolder, HashLock to both instances
// Run an atomic swap between the chains (Happy Case, Direct Funding)
// Record time taken and gas consumed
// Explore unhappy cases
// Explore off-chain funding use case

const executorWallet = ethers.Wallet.createRandom();
const responderWallet = ethers.Wallet.createRandom();
const deployerWallet = ethers.Wallet.createRandom(); // to deploy contracts

const left = {
  gasPrice: ethers.constants.One.toHexString(),
  port: 9001,
  _chainId: 66,
  _chainIdRpc: 66,
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
  _chainId: 99,
  _chainIdRpc: 99,
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

(async function () {
  const executor: Actor = {
    signingWallet: executorWallet,
    log: (s: string) => console.log(chalk.keyword("orangered")("> " + s)),
    gasSpent: 0,
    getLeftBalance: async () =>
      await leftChain.getBalance(executorWallet.address),
    getRightBalance: async () =>
      await rightChain.getBalance(executorWallet.address),
  };
  const responder: Actor = {
    signingWallet: responderWallet,
    log: (s: string) => console.log(chalk.keyword("gray")("< " + s)),
    gasSpent: 0,
    getLeftBalance: async () =>
      await leftChain.getBalance(responderWallet.address),
    getRightBalance: async () =>
      await rightChain.getBalance(responderWallet.address),
  };

  await logBalances(executor, responder);

  // SETUP CONTRACTS ON BOTH CHAINS
  // Deploy the contracts to chain, and then reconnect them to their respective signers
  // for the rest of the interactions
  const [
    leftChannelMasterCopy,
    leftChannelFactory,
    leftHashLock,
  ] = await deployContractsToChain(leftChain);
  const [
    rightChannelMasterCopy,
    rightChannelFactory,
    rightHashLock,
  ] = await deployContractsToChain(rightChain);

  // given the longChannel is now funded and running
  // the responder needs to incentivize the executor to do the swap

  // executor unlocks payment that benefits him
  // responder decodes the preimage and unlocks the payment that benefits her
  // both channels are collaboratively defunded
  await logBalances(executor, responder);

  // teardown blockchains
  await leftServer.close();
  await rightServer.close();
})();

interface Actor {
  signingWallet: ethers.Wallet;
  log: (s: string) => void;
  gasSpent: number;
  getLeftBalance: () => Promise<ethers.BigNumber>;
  getRightBalance: () => Promise<ethers.BigNumber>;
}
async function deployContractsToChain(chain: ethers.providers.JsonRpcProvider) {
  // This is a one-time operation, so we do not count the gas costs
  // use index 1 (deployer) to pay the ETH
  const deployer = await chain.getSigner(1);

  const channelMasterCopy = await new ContractFactory(
    artifacts.ChannelMastercopy.abi,
    artifacts.ChannelMastercopy.bytecode,
    deployer
  ).deploy();

  const channelFactory = await new ContractFactory(
    artifacts.ChannelFactory.abi,
    artifacts.ChannelFactory.bytecode,
    deployer
  ).deploy(channelMasterCopy.address, 0); // args are channelMasterCopy and chainId, but we can use zero for the chainid
  //   https://github.com/connext/vector/blob/main/modules/contracts/src.sol/ChannelFactory.sol#L28

  const hashLock = await new ContractFactory(
    artifacts.HashlockTransfer.abi,
    artifacts.HashlockTransfer.bytecode,
    deployer
  ).deploy();

  return [channelMasterCopy, channelFactory, hashLock].map((contract) =>
    contract.connect(chain.getSigner(0))
  );
}

async function logBalances(...actors: Actor[]) {
  for await (const actor of actors) {
    actor.log(
      `I have ${(
        await actor.getLeftBalance()
      ).toString()} wei on the left chain`
    );
    actor.log(
      `I have ${(
        await actor.getRightBalance()
      ).toString()} wei on the right chain`
    );
  }
}
