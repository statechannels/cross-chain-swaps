import { Contract, ContractFactory, ethers } from "ethers";
import ganache = require("ganache-core");
import {
  ContractArtifacts,
  Bytes32,
  State,
  Channel,
  Outcome,
  signState,
  getChannelId,
  getVariablePart,
  AllocationAssetOutcome,
  getFixedPart,
  hashAppPart,
  encodeOutcome,
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
interface HashLockedSwapData {
  h: Bytes32;
  preImage: string; // Bytes
}

function encodeHashLockedSwapData(data: HashLockedSwapData): string {
  return ethers.utils.defaultAbiCoder.encode(
    ["tuple(bytes32 h, bytes preImage)"],
    [data]
  );
}

function decodeHashLockedSwapData(data: string): HashLockedSwapData {
  const { h, preImage } = ethers.utils.defaultAbiCoder.decode(
    ["tuple(bytes32 h, bytes preImage)"],
    data
  )[0];
  return { h, preImage };
}

const preImage = "0xdeadbeef";
const correctPreImage: HashLockedSwapData = {
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
    getLeftBalance: async () => await leftSigner.getBalance(),
    getRightBalance: async () =>
      await rightChain.getBalance(await leftSigner.getAddress()),
  };
  const responder: Actor = {
    signingWallet: ethers.Wallet.createRandom(),
    destination: ethers.utils.hexZeroPad(await rightSigner.getAddress(), 32),
    log: (s: string) => console.log(chalk.keyword("gray")("< " + s)),
    gasSpent: 0,
    getLeftBalance: async () =>
      await leftChain.getBalance(rightSigner.getAddress()),
    getRightBalance: async () => await rightSigner.getBalance(),
  };

  await logBalances(executor, responder);

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
    responder,
    ethers.utils.keccak256(preImage)
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
    executor,
    decodeHashLockedSwapData(_PreFund0.appData).h
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
    appData: encodeHashLockedSwapData(correctPreImage),
    outcome: swap(_preFund0.outcome),
  };
  const unlock4 = signState(_unlock4, executor.signingWallet.privateKey);

  // responder decodes the preimage and unlocks the payment that benefits her
  const decodedPreImage = decodeHashLockedSwapData(unlock4.state.appData)
    .preImage;
  const decodedHash = decodeHashLockedSwapData(unlock4.state.appData).h;
  const _Unlock4: State = {
    ..._PreFund0,
    turnNum: 4,
    appData: encodeHashLockedSwapData({
      h: decodedHash,
      preImage: decodedPreImage,
    }),
    outcome: swap(_PreFund0.outcome),
  };
  const Unlock4 = signState(_Unlock4, responder.signingWallet.privateKey);

  // both channels are collaboratively defunded
  await Promise.all([
    defundChannel(
      _preFund0,
      _unlock4,
      responder,
      executor,
      rightHashLock,
      rightNitroAdjudicator
    ),
    defundChannel(
      _PreFund0,
      _Unlock4,
      executor,
      responder,
      leftHashLock,
      leftNitroAdjudicator
    ),
  ]);

  await logBalances(executor, responder);

  // teardown blockchains
  await leftServer.close();
  await rightServer.close();
})();

interface Actor {
  destination: string;
  signingWallet: ethers.Wallet;
  log: (s: string) => void;
  gasSpent: number;
  getLeftBalance: () => Promise<ethers.BigNumber>;
  getRightBalance: () => Promise<ethers.BigNumber>;
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
    ContractArtifacts.HashLockedSwap,
    signer
  ).deploy();

  return [nitroAdjudicator, eTHAssetHolder, hashLock];
}

function createHashLockChannel(
  chainId: number,
  challengeDuration: number,
  appDefinition: string,
  assetHolderAddress: string,
  proposer: { destination: string; signingWallet: ethers.Wallet },
  joiner: { destination: string; signingWallet: ethers.Wallet },
  hash
) {
  const appData = encodeHashLockedSwapData({ h: hash, preImage: "0x" });
  const channel: Channel = {
    chainId: ethers.utils.hexlify(chainId),
    channelNonce: 0, // this is the first channel between these participants on this chain
    participants: [
      proposer.signingWallet.address,
      joiner.signingWallet.address,
    ],
  };
  const outcome: AllocationAssetOutcome[] = [
    {
      assetHolderAddress,
      allocationItems: [
        {
          destination: proposer.destination,
          amount: ethers.constants.WeiPerEther.mul(100).toHexString(),
        },
        {
          destination: joiner.destination,
          amount: ethers.constants.Zero.toHexString(),
        },
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
  proposer.gasSpent += Number(depositGas);
  proposer.log("spent " + proposer.gasSpent + " gas");

  await responderToReactToDeposit;

  return channelId;
}

async function defundChannel(
  initialState: State,
  unlockState: State,
  proposer: Actor,
  joiner: Actor,
  hashLock: Contract,
  nitroAdjudicator: Contract
) {
  const unlockValid = await hashLock.validTransition(
    getVariablePart(initialState),
    getVariablePart(unlockState),
    4, // turnNumB
    2 // numParticipants
  );
  if (!unlockValid) throw Error;
  proposer.log(
    `I verified your unlock was valid; Here's a final state to help you withdraw on chain ${initialState.channel.chainId}`
  );
  const _isFinal5: State = { ...initialState, isFinal: true };
  const isFinal5 = signState(_isFinal5, proposer.signingWallet.privateKey);
  // isFinal5 sent to joiner
  joiner.log("Countersigning and calling concludePushOutcomeAndTransferAll...");
  const sigs = [
    isFinal5.signature,
    signState(_isFinal5, joiner.signingWallet.privateKey).signature,
  ];
  const { gasUsed } = await (
    await nitroAdjudicator.concludePushOutcomeAndTransferAll(
      _isFinal5.turnNum,
      getFixedPart(_isFinal5),
      hashAppPart(_isFinal5),
      encodeOutcome(_isFinal5.outcome),
      1,
      [0, 0],
      sigs
    )
  ).wait();
  joiner.gasSpent += Number(gasUsed);
  joiner.log(`Spent ${gasUsed} gas, total ${joiner.gasSpent}`);
}

function swap(outcome: Outcome) {
  if (!("allocationItems" in outcome[0])) throw Error;
  const swappedOutome: AllocationAssetOutcome[] = [
    {
      assetHolderAddress: outcome[0].assetHolderAddress,
      allocationItems: [
        {
          destination: outcome[0].allocationItems[0].destination,
          amount: outcome[0].allocationItems[1].amount,
        },
        {
          destination: outcome[0].allocationItems[1].destination,
          amount: outcome[0].allocationItems[0].amount,
        },
      ],
    },
  ];
  return swappedOutome;
}

async function logBalances(...actors: Actor[]) {
  for await (const actor of actors) {
    actor.log(`I have ${await actor.getLeftBalance()} ETH on the left chain`);
    actor.log(`I have ${await actor.getRightBalance()} ETH on the right chain`);
  }
}
