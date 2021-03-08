import { ContractFactory, ethers } from "ethers";
import ganache = require("ganache-core");
import {
  ContractArtifacts,
  Bytes32,
  State,
  Channel,
  Outcome,
  signState,
  getChannelId,
} from "@statechannels/nitro-protocol";
import chalk = require("chalk");

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
const leftSigner = leftChain.getSigner();

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
const rightSigner = rightChain.getSigner();

// Utilities
// TODO: move to a src file
interface HashLockData {
  h: Bytes32;
  preImage: string; // Bytes
}

function encodeHashLockData(data: HashLockData): string {
  return ethers.utils.defaultAbiCoder.encode(
    ["tuple(bytes32 h, bytes preImage)"],
    [data]
  );
}

const preImage = "0xdeadbeef";
const conditionalPayment: HashLockData = {
  h: ethers.utils.keccak256(preImage),
  // ^^^^ important field (SENDER)
  preImage: "0x",
};

const correctPreImage: HashLockData = {
  preImage: preImage,
  // ^^^^ important field (RECEIVER)
  h: ethers.constants.HashZero,
};

// *****

(async function () {
  const executor = {
    signingWallet: ethers.Wallet.createRandom(),
    inbox: [],
    destination: ethers.utils.hexZeroPad(await leftSigner.getAddress(), 32),
    log: (s: string) => console.log(chalk.keyword("orange")("> " + s)),
  };
  const responder = {
    signingWallet: ethers.Wallet.createRandom(),
    inbox: [],
    destination: ethers.utils.hexZeroPad(await rightSigner.getAddress(), 32),
    log: (s: string) => console.log(chalk.keyword("blue")("< " + s)),
  };

  // SETUP CONTRACTS ON BOTH CHAINS
  const leftNitroAdjudicator = await ContractFactory.fromSolidity(
    ContractArtifacts.NitroAdjudicatorArtifact,
    leftSigner
  ).deploy();

  const leftETHAssetHolder = await ContractFactory.fromSolidity(
    ContractArtifacts.EthAssetHolderArtifact,
    leftSigner
  ).deploy(leftNitroAdjudicator.address);

  const leftHashLock = await ContractFactory.fromSolidity(
    ContractArtifacts.HashLock,
    leftSigner
  ).deploy();

  const rightNitroAdjudicator = await ContractFactory.fromSolidity(
    ContractArtifacts.NitroAdjudicatorArtifact,
    rightSigner
  ).deploy();

  const rightETHAssetHolder = await ContractFactory.fromSolidity(
    ContractArtifacts.EthAssetHolderArtifact,
    rightSigner
  ).deploy(rightNitroAdjudicator.address);

  const rightHashLock = await ContractFactory.fromSolidity(
    ContractArtifacts.HashLock,
    rightSigner
  ).deploy();

  // CONSTRUCT THE LONG CHANNEL (funded on left chain)
  const chainId = ethers.utils.hexlify(left._chainId);
  /* 
    Define the channelNonce 
    :~ how many times have these participants
    already run a channel on this chain?
  */
  const channelNonce = 0;

  /* 
    Define the challengeDuration (in seconds)
    :~ how long should participants get to respond to challenges?
  */
  const challengeDuration = 60; // 1 minute

  /* 
    Mock out the appDefinition and appData.
    We will get to these later in the tutorial
  */
  const appDefinition = leftHashLock.address;
  const appData = encodeHashLockData(conditionalPayment);

  /* Construct a Channel object */
  const longChannel: Channel = {
    chainId,
    channelNonce,
    participants: [
      executor.signingWallet.address,
      responder.signingWallet.address,
    ],
  };

  /* Mock out an outcome */
  const outcome: Outcome = [
    {
      assetHolderAddress: leftETHAssetHolder.address,
      allocationItems: [
        { destination: executor.destination, amount: "0x1" },
        { destination: responder.destination, amount: "0x0" },
      ],
    },
  ];

  const _pf0: State = {
    turnNum: 0,
    isFinal: false,
    channel: longChannel,
    challengeDuration,
    outcome,
    appDefinition,
    appData,
  };

  // Executor proposes a channel with a hashlocked payment for the proposer
  const pf0 = signState(_pf0, executor.signingWallet.privateKey);

  // not shown: pf0 delivered to responder
  executor.log("I propose a hashlocked payment, sending PreFund1");
  // skip: Responder checks that the timeout is long enough
  // skip: Responder checks that their destination is in the channel (in the receiving slot)
  // skip: When responder verifies that pf1 is supported...
  // Responder joins channel and watches the left chain for funding
  const _pf1: State = { ..._pf0, turnNum: 1 };
  const pf1 = signState(_pf1, responder.signingWallet.privateKey);

  const responderToReactToDeposit = new Promise((resolve, reject) => {
    const listener = (from, to, amount, event) => {
      if (!ethers.BigNumber.from(event.args.destinationHoldings).isZero()) {
        // TODO check against the amount specified in the outcome on the state
        const _pf2: State = { ..._pf0, turnNum: 2 };
        const pf2 = signState(_pf2, responder.signingWallet.privateKey);
        responder.log("I see your deposit and send PostFund2");
        resolve(event);
      }
    };
    leftETHAssetHolder.once("Deposited", listener);
  });

  // not shown: pf1 is delivered to executor

  // Executor funds channel
  const receipt = await (
    await leftETHAssetHolder.deposit(getChannelId(longChannel), 0, 1, {
      value: 1,
    })
  ).wait();

  await responderToReactToDeposit;

  // teardown blockchains
  await leftServer.close();
  await rightServer.close();
})();
