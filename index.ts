import { ContractFactory, ethers } from "ethers";
import ganache = require("ganache-core");
import {
  ContractArtifacts,
  Bytes32,
  State,
  Channel,
  Outcome,
  signState,
} from "@statechannels/nitro-protocol";

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
  };
  const responder = {
    signingWallet: ethers.Wallet.createRandom(),
    inbox: [],
    destination: ethers.utils.hexZeroPad(await rightSigner.getAddress(), 32),
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
  const channel: Channel = {
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
    channel,
    challengeDuration,
    outcome,
    appDefinition,
    appData,
  };

  // Executor proposes a channel with a hashlocked payment for the proposer
  const pf0 = signState(_pf0, executor.signingWallet.privateKey);

  // not shown: pf0 delivered to responder

  // teardown blockchains
  await leftServer.close();
  await rightServer.close();
})();
