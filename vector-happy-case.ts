import { BigNumber, Contract, ContractFactory, ethers } from "ethers";
import ganache = require("ganache-core");
import chalk = require("chalk");
import { artifacts } from "@connext/vector-contracts";
import { Vector } from "@connext/vector-protocol";
import { CoreChannelState, CoreTransferState } from "@connext/vector-types";
import { hashChannelCommitment } from "@connext/vector-utils";
import { solidityKeccak256 } from "ethers/lib/utils";

// See https://github.com/connext/vector/blob/main/modules/protocol/src/testing/integration/happy.spec.ts
// Will it be easier to use vector class instances (wallets)? Or try and go state-by-state as we did with nitro?
// @connext do not really export much from their protocol. It's all only accesible via the Vector class.

// Spin up two instances of ganache.
// alice is assumed to be a high-fidelity user (has gas in their signing address) and bob is assumed to be a low-fidelity user (doesn't always have gas in their signing address).
// Bob is the user. Alice is the node.
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
    leftTransferRegistry,
  ] = await deployContractsToChain(leftChain);
  const [
    rightChannelMasterCopy,
    rightChannelFactory,
    rightHashLock,
    rightTransferRegistry,
  ] = await deployContractsToChain(rightChain);

  const leftCore = await createAndFundChannel(
    leftChain,
    executor,
    responder,
    leftChannelFactory,
    leftChannelMasterCopy
  );

  const leftConditionalTransfer: CoreTransferState = {
    channelAddress: leftCore.channelAddress,
    transferId: "todo",
    transferDefinition: leftHashLock.address,
    initiator: executorWallet.address,
    responder: responderWallet.address,
    assetId: ethers.constants.HashZero,
    balance: { amount: ["0x1"], to: [executorWallet.address] },
    transferTimeout: leftCore.timeout,
    initialStateHash: ethers.constants.HashZero, // TODO
  };

  // TODO sign and send this state.

  const rightCore = await createAndFundChannel(
    rightChain,
    responder,
    executor,
    rightChannelFactory,
    rightChannelMasterCopy
  );

  // given the longChannel is now funded and running
  // the responder needs to incentivize the executor to do the swap
  // TODO sign and send a rightConditionalTransfer

  // TODO
  // executor unlocks payment that benefits him
  // responder decodes the preimage and unlocks the payment that benefits her
  // both channels are collaboratively defunded

  // Now we want to withdraw on both chains

  //   const leftVectorChannel = await new Contract(
  //     leftChannelAddress,
  //     artifacts.VectorChannel.abi,
  //     leftChain.getSigner(0)
  //   );

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

  const transferRegistry = await new ContractFactory(
    artifacts.TransferRegistry.abi,
    artifacts.TransferRegistry.bytecode,
    deployer
  ).deploy();

  return [
    channelMasterCopy,
    channelFactory,
    hashLock,
    transferRegistry,
  ].map((contract) => contract.connect(chain.getSigner(0)));
}
async function createAndFundChannel(
  chain: ethers.providers.JsonRpcProvider,
  proposer: Actor,
  joiner: Actor,
  channelFactory: Contract,
  channelMasterCopy: Contract
) {
  const channelAddress = ethers.utils.getCreate2Address(
    channelFactory.address,
    solidityKeccak256(
      ["address", "address", "uint256"],
      [executorWallet.address, responderWallet.address, left._chainId]
    ),
    solidityKeccak256(
      ["bytes"],
      [getMinimalProxyInitCode(channelMasterCopy.address)]
    )
  );

  //   console.log(leftChannelAddress);

  //   const leftSetupParams = {
  //     counterpartyIdentifier: "responder-identifier", //TODO
  //     timeout: (60 * 60 * 24 * 2).toString(), // 48 hrs is default
  //     networkContext: {
  //       chainId: left._chainId,
  //       channelFactoryAddress: leftChannelFactory.address,
  //       transferRegistryAddress: leftTransferRegistry.address,
  //     },
  //   };

  //   const participants = [executorWallet.address, responderWallet.address];

  const core: CoreChannelState = {
    nonce: 1,
    channelAddress: channelAddress, // depends on chainId
    // should have the to field filled out
    alice: executorWallet.address,
    bob: responderWallet.address,
    assetIds: [ethers.constants.AddressZero],
    balances: [{ amount: ["0x1"], to: [responderWallet.address] }],
    processedDepositsA: [],
    processedDepositsB: [],
    defundNonces: [],
    timeout: (60 * 60 * 24 * 2).toString(), // 48 hrs is default,
    merkleRoot: "",
  };

  // TODO signatures
  //   const commitment = {
  //     core,
  //     aliceSignature: await executorWallet.signMessage(
  //       hashChannelCommitment(core)
  //     ),
  //     // now send to Bob, and get his countersignature
  //     bobSignature: await responderWallet.signMessage(
  //       hashChannelCommitment(core)
  //     ),
  //   };

  // Bob does not desposit, because there are no funds for him in the channel
  // https://github.com/connext/vector/blob/54f050202290769b0d672d362493b783610908dd/modules/protocol/src/testing/utils/channel.ts#L188
  // confused: it looks like Alice calls deposit AND does a regular transfer; Bob does just a transfer
  // https://github.com/connext/vector/blob/54f050202290769b0d672d362493b783610908dd/modules/protocol/src/testing/utils/channel.ts#L151-L186
  // Alice creates the multisig and then deposits
  // Possible optimization:  couldn't she just send the deposit in with this createChannel call?
  const { gasUsed } = await (
    await channelFactory.createChannel(
      executorWallet.address,
      responderWallet.address
    )
  ).wait(); // Note that we ignore who *actually* sent the transaction, but attribute it to the executor here
  // ideally we check that the new contract deployed at the address we expect

  proposer.gasSpent += Number(gasUsed);
  proposer.log(
    `called ChannelFactory.createChannel on left chain, spent ${gasUsed} gas`
  );

  const { gasUsed: gasUsed2 } = await (
    await leftChain.sendTransaction(
      await executorWallet.signTransaction({
        nonce: await leftChain.getTransactionCount(executorWallet.address),
        value: core.balances[0].amount[0],
        to: channelAddress,
        gasLimit: 8e5,
      })
    )
  ).wait();

  proposer.gasSpent += gasUsed2.toNumber();
  proposer.log(
    `sent ETH to the channel on left chain, spent ${gasUsed2} gas, total ${proposer.gasSpent}`
  );

  // TODO next Alice sends a deposit update in the channel. This is like a post fund setup (I think)
  // within vector client code, the amounts will be read off the chain
  return core;
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

// functions pulled out of @connext/vector-utils
export const getMinimalProxyInitCode = (mastercopyAddress: string): string =>
  `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${mastercopyAddress
    .toLowerCase()
    .replace(/^0x/, "")}5af43d82803e903d91602b57fd5bf3`;
