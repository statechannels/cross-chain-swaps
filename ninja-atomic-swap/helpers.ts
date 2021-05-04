import { Contract, ContractFactory, ethers } from "ethers";
import {
  ContractArtifacts,
  TestContractArtifacts,
} from "@statechannels/nitro-protocol";
import {
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
  convertAddressToBytes32,
} from "@statechannels/nitro-protocol";
import { Actor, parseTransaction } from "../common/two-chain-setup";
import { SWAP_AMOUNT } from "../constants";

export async function deployContractsToChain(
  chain: ethers.providers.JsonRpcProvider
) {
  // This is a one-time operation, so we do not count the gas costs
  // use index 1 (deployer) to pay the ETH
  const deployer = await chain.getSigner(1);

  const adjudicatorFactory = await ContractFactory.fromSolidity(
    ContractArtifacts.NinjaNitro.AdjudicatorFactory,
    deployer
  ).deploy();

  const masterCopy = await ContractFactory.fromSolidity(
    ContractArtifacts.NinjaNitro.SingleChannelAdjudicatorArtifact,
    deployer
  ).deploy(adjudicatorFactory.address);

  await (
    await adjudicatorFactory
      .connect(chain.getSigner(0))
      .setup(masterCopy.address)
  ).wait();

  const token = await ContractFactory.fromSolidity(
    TestContractArtifacts.TokenArtifact,
    deployer
  ).deploy(await chain.getSigner(0).getAddress());

  const hashLock = await ContractFactory.fromSolidity(
    ContractArtifacts.HashLockedSwapArtifact,
    deployer
  ).deploy();

  return [adjudicatorFactory, masterCopy, hashLock, token].map((contract) =>
    contract.connect(chain.getSigner(0))
  );
}

// Utilities
interface HashLockedSwapData {
  h: Bytes32;
  preImage: string; // Bytes
}

export function encodeHashLockedSwapData(data: HashLockedSwapData): string {
  return ethers.utils.defaultAbiCoder.encode(
    ["tuple(bytes32 h, bytes preImage)"],
    [data]
  );
}

export function decodeHashLockedSwapData(data: string): HashLockedSwapData {
  const { h, preImage } = ethers.utils.defaultAbiCoder.decode(
    ["tuple(bytes32 h, bytes preImage)"],
    data
  )[0];
  return { h, preImage };
}

export const preImage = "0xdeadbeef";
export const correctPreImage: HashLockedSwapData = {
  preImage: preImage,
  // ^^^^ important field (RECEIVER)
  h: ethers.constants.HashZero,
};

export function createHashLockChannel(
  chainId: number,
  challengeDuration: number,
  appDefinition: string,
  assetHolderAddress: string,
  proposer: Actor,
  joiner: Actor,
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
          destination: convertAddressToBytes32(proposer.signingWallet.address),
          amount: SWAP_AMOUNT,
        },
        {
          destination: convertAddressToBytes32(joiner.signingWallet.address),
          amount: "0x0",
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

export async function fundChannel(
  chain: ethers.providers.JsonRpcProvider,
  adjudicatorFactory: ethers.Contract,
  token: ethers.Contract,
  initialState: State,
  proposer: Actor,
  joiner: Actor
) {
  const { chainId } = await chain.getNetwork();
  const channelId = getChannelId(initialState.channel);
  const channelAddress = adjudicatorFactory.getChannelAddress(channelId);
  // Proposer proposes a channel with a hashlocked payment for the joiner
  const PreFund0 = signState(initialState, proposer.signingWallet.privateKey);
  // not shown: pf0 delivered to joiner
  proposer.log(
    `I propose a hashlocked payment, sending PreFund0 for chain ${initialState.channel.chainId}`
  );
  // skip: Joiner checks that the timeout is long enough
  // skip: Joiner checks that their destination is in the channel (in the receiving slot)
  // skip: When joiner verifies that pf1 is supported...
  // Joiner joins channel and watches the left chain for funding
  const _PreFund1: State = { ...initialState, turnNum: 1 };
  const PreFund1 = signState(_PreFund1, joiner.signingWallet.privateKey);
  joiner.log(
    `Sure thing. Your channel looks good. Sending PreFund1 for chain ${initialState.channel.chainId}`
  );

  const joinerToReactToDeposit = new Promise((resolve, reject) => {
    const listener = (from, to, amount, event) => {
      if (!ethers.BigNumber.from(event.args.value).isZero()) {
        // TODO check the recipient is in fact the channel
        const _PostFund3: State = { ...initialState, turnNum: 3 };
        const PostFund3 = signState(
          _PostFund3,
          joiner.signingWallet.privateKey
        );
        // not shown: PostFund3 delivered to proposer
        joiner.log(
          `I see your deposit and send PostFund3 for chain ${initialState.channel.chainId}`
        );
        resolve(event);
      }
    };
    token.once("Transfer", listener);
  });

  // const value = (initialState.outcome[0] as AllocationAssetOutcome)
  //   .allocationItems[0].amount;

  let tx;
  if (token) {
    tx = await token.transfer(channelAddress, SWAP_AMOUNT);
  } else {
    tx = await chain.getSigner().sendTransaction({
      to: channelAddress,
      value: SWAP_AMOUNT,
    });
    // Note that we ignore who *actually* sent the transaction, but attribute it to the proposer here
  }

  const gasUsed = await parseTransaction(chain, tx, "fundChannel");

  proposer.gasSpent += Number(gasUsed);
  proposer.log(
    `sent funds to contract on chain ${chainId}, spent ${gasUsed} gas`
  );

  // not shown: PreFund1 is delivered to joiner
  const _PostFund2: State = { ...initialState, turnNum: 2 };
  signState(_PostFund2, proposer.signingWallet.privateKey);
  proposer.log(
    `I have made my deposit, and send PostFund2 for chain ${initialState.channel.chainId}`
  );

  await joinerToReactToDeposit;

  return channelId;
}

export async function defundChannel(
  initialState: State,
  unlockState: State,
  proposer: Actor,
  joiner: Actor,
  hashLock: Contract,
  adjudicatorFactory: Contract
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
  const _isFinal5: State = { ...unlockState, isFinal: true };
  const isFinal5 = signState(_isFinal5, proposer.signingWallet.privateKey);
  // isFinal5 sent to joiner
  joiner.log("Countersigning...");
  const sigs = [
    isFinal5.signature,
    signState(_isFinal5, joiner.signingWallet.privateKey).signature,
  ];

  const tx = await adjudicatorFactory.createAndPayout(
    getChannelId(unlockState.channel),
    _isFinal5.turnNum,
    getFixedPart(_isFinal5),
    hashAppPart(_isFinal5),
    encodeOutcome(_isFinal5.outcome),
    1,
    [0, 0],
    sigs
  );
  const gasUsed = await parseTransaction(
    adjudicatorFactory.provider,
    tx,
    "createAndPayout"
  );
  joiner.gasSpent += Number(gasUsed);
  joiner.log(
    `Spent ${gasUsed} gas calling adjudicatorFactory.deployAndPayout, total ${joiner.gasSpent}`
  );
  // await concludedEvent;
}

export function swap(outcome: Outcome): Outcome {
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
