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
  _chainId: 99,
  _chainIdRpc: 99,
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

function decodeHashLockData(data: string): HashLockData {
  const { h, preImage } = ethers.utils.defaultAbiCoder.decode(
    ["tuple(bytes32 h, bytes preImage)"],
    data
  )[0];
  return { h, preImage };
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
  const executor: Actor = {
    signingWallet: ethers.Wallet.createRandom(),
    destination: ethers.utils.hexZeroPad(await leftSigner.getAddress(), 32),
    log: (s: string) => console.log(chalk.keyword("orangered")("> " + s)),
    gasSpent: 0,
  };
  const responder: Actor = {
    signingWallet: ethers.Wallet.createRandom(),
    destination: ethers.utils.hexZeroPad(await rightSigner.getAddress(), 32),
    log: (s: string) => console.log(chalk.keyword("gray")("< " + s)),
    gasSpent: 0,
  };

  // SETUP CONTRACTS ON BOTH CHAINS
  // In reality, the executor and responder would have their own providers / signers for both chains
  // For simplicity, they share providers here.
  const [
    leftNitroAdjudicator,
    leftETHAssetHolder,
    leftHashLock,
  ] = await deployContractsToChain(leftChain);
  const [
    rightNitroAdjudicator,
    rightETHAssetHolder,
    rightHashLock,
  ] = await deployContractsToChain(rightChain);

  const _PreFund0 = createHashLockChannel(
    left._chainId,
    60,
    leftHashLock.address,
    leftETHAssetHolder.address,
    executor,
    responder
  );

  // exchanges setup states and funds on left chain
  const longChannel = await fundChannel(
    leftETHAssetHolder,
    _PreFund0,
    executor,
    responder
  );

  // given the longChannel is now funded and running
  // the responder needs to incentivize the executor to do the swap
  const _preFund0 = createHashLockChannel(
    right._chainId,
    30,
    rightHashLock.address,
    rightETHAssetHolder.address,
    responder,
    executor
  );

  const shortChannel = await fundChannel(
    rightETHAssetHolder,
    _preFund0,
    responder,
    executor
  );

  // executor unlocks payment that benefits him
  const _unlock4: State = {
    ..._preFund0,
    turnNum: 4,
    appData: encodeHashLockData(correctPreImage),
  };
  const unlock4 = signState(_unlock4, executor.signingWallet.privateKey);

  // responder decodes the preimage and unlocks the payment that benefits her
  const decodedPreImage = decodeHashLockData(unlock4.state.appData).preImage;
  const decodedHash = decodeHashLockData(unlock4.state.appData).h;
  const _Unlock4: State = {
    ..._PreFund0,
    turnNum: 4,
    appData: encodeHashLockData({ h: decodedHash, preImage: decodedPreImage }),
  };
  const Unlock4 = signState(_Unlock4, responder.signingWallet.privateKey);

  // both channels are collaboratively defunded

  // teardown blockchains
  await leftServer.close();
  await rightServer.close();
})();

interface Actor {
  destination: string;
  signingWallet: ethers.Wallet;
  log: (s: string) => void;
  gasSpent: number;
}
async function deployContractsToChain(chain: ethers.providers.JsonRpcProvider) {
  // This is a one-time operation, so we do not count the gas costs
  const signer = await chain.getSigner();

  const nitroAdjudicator = await ContractFactory.fromSolidity(
    ContractArtifacts.NitroAdjudicatorArtifact,
    signer
  ).deploy();

  const eTHAssetHolder = await ContractFactory.fromSolidity(
    ContractArtifacts.EthAssetHolderArtifact,
    signer
  ).deploy(nitroAdjudicator.address);

  const hashLock = await ContractFactory.fromSolidity(
    ContractArtifacts.HashLock,
    signer
  ).deploy();

  return [nitroAdjudicator, eTHAssetHolder, hashLock];
}

// TODO should accept the hash we want to set up with
function createHashLockChannel(
  chainId: number,
  challengeDuration: number,
  appDefinition: string,
  assetHolderAddress: string,
  proposer: { destination: string; signingWallet: ethers.Wallet },
  joiner: { destination: string; signingWallet: ethers.Wallet }
) {
  const appData = encodeHashLockData(conditionalPayment);

  /* Construct a Channel object */
  const channel: Channel = {
    chainId: ethers.utils.hexlify(chainId),
    channelNonce: 0, // this is the first channel between these participants on this chain
    participants: [
      proposer.signingWallet.address,
      joiner.signingWallet.address,
    ],
  };

  /* Mock out an outcome */
  const outcome: Outcome = [
    {
      assetHolderAddress,
      allocationItems: [
        { destination: proposer.destination, amount: "0x1" },
        { destination: joiner.destination, amount: "0x0" },
      ],
    },
  ];

  const initialState: State = {
    turnNum: 0,
    isFinal: false,
    channel,
    challengeDuration,
    outcome,
    appDefinition,
    appData,
  };

  return initialState;
}

async function fundChannel(
  eTHAssetHolder: ethers.Contract,
  initialState: State,
  proposer: Actor,
  joiner: Actor
) {
  // Executor proposes a channel with a hashlocked payment for the proposer
  const PreFund0 = signState(initialState, proposer.signingWallet.privateKey);
  const channelId = getChannelId(initialState.channel);
  // not shown: pf0 delivered to responder
  proposer.log(
    `I propose a hashlocked payment, sending PreFund0 for chain ${initialState.channel.chainId}`
  );
  // skip: Responder checks that the timeout is long enough
  // skip: Responder checks that their destination is in the channel (in the receiving slot)
  // skip: When responder verifies that pf1 is supported...
  // Responder joins channel and watches the left chain for funding
  const _PreFund1: State = { ...initialState, turnNum: 1 };
  const PreFund1 = signState(_PreFund1, joiner.signingWallet.privateKey);
  joiner.log(
    `Sure thing. Your channel looks good. Sending PreFund1 for chain ${initialState.channel.chainId}`
  );

  const responderToReactToDeposit = new Promise((resolve, reject) => {
    const listener = (from, to, amount, event) => {
      if (!ethers.BigNumber.from(event.args.destinationHoldings).isZero()) {
        // TODO check against the amount specified in the outcome on the state
        const _PostFund3: State = { ...initialState, turnNum: 3 };
        const PostFund3 = signState(
          _PostFund3,
          joiner.signingWallet.privateKey
        );
        // not shown: PostFund3 delivered to executor
        joiner.log(
          `I see your deposit and send PostFund3 for chain ${initialState.channel.chainId}`
        );
        resolve(event);
      }
    };
    eTHAssetHolder.once("Deposited", listener);
  });

  // not shown: PreFund1 is delivered to executor
  const _PostFund2: State = { ...initialState, turnNum: 2 };
  signState(_PostFund2, proposer.signingWallet.privateKey);
  proposer.log(
    `I have made my deposit, and send PostFund2 for chain ${initialState.channel.chainId}`
  );

  // Executor funds channel (costs gas)
  const { gasUsed: depositGas } = await (
    await eTHAssetHolder.deposit(channelId, 0, 1, {
      value: 1,
    })
  ).wait();
  proposer.gasSpent += depositGas;
  proposer.log("spent " + proposer.gasSpent + " gas");

  await responderToReactToDeposit;

  return channelId;
}
