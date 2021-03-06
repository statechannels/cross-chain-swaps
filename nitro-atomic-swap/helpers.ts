import { Contract, ContractFactory, ethers } from 'ethers';
import {
    ContractArtifacts,
    hashState,
    signChallengeMessage,
    SignedState,
    TestContractArtifacts,
} from '@statechannels/nitro-protocol';
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
} from '@statechannels/nitro-protocol';
import {
    Actor,
    advanceBlocktime,
    parseTransaction,
} from '../common/two-chain-setup';
import { SWAP_AMOUNT } from '../constants';

export async function deployContractsToChain(
    chain: ethers.providers.JsonRpcProvider
) {
    // This is a one-time operation, so we do not count the gas costs
    // use index 1 (deployer) to pay the ETH
    const deployer = await chain.getSigner(1);

    const nitroAdjudicator = await ContractFactory.fromSolidity(
        ContractArtifacts.NitroAdjudicatorArtifact,
        deployer
    ).deploy();

    const token = await ContractFactory.fromSolidity(
        TestContractArtifacts.TokenArtifact,
        deployer
    ).deploy(await chain.getSigner(0).getAddress());

    const erc20AssetHolder = await ContractFactory.fromSolidity(
        ContractArtifacts.Erc20AssetHolderArtifact,
        deployer
    ).deploy(nitroAdjudicator.address, token.address);

    const hashLock = await ContractFactory.fromSolidity(
        ContractArtifacts.HashLockedSwapArtifact,
        deployer
    ).deploy();

    await (
        await token
            .connect(chain.getSigner(0))
            .transfer(erc20AssetHolder.address, 1)
    ).wait(); // preload assetholder to represent real-world usage

    return [
        nitroAdjudicator,
        erc20AssetHolder,
        hashLock,
        token,
    ].map((contract) => contract.connect(chain.getSigner(0)));
}

// Utilities
interface HashLockedSwapData {
    h: Bytes32;
    preImage: string; // Bytes
}

export function encodeHashLockedSwapData(data: HashLockedSwapData): string {
    return ethers.utils.defaultAbiCoder.encode(
        ['tuple(bytes32 h, bytes preImage)'],
        [data]
    );
}

export function decodeHashLockedSwapData(data: string): HashLockedSwapData {
    const { h, preImage } = ethers.utils.defaultAbiCoder.decode(
        ['tuple(bytes32 h, bytes preImage)'],
        data
    )[0];
    return { h, preImage };
}

export const preImage = '0xdeadbeef';
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
    proposerWallet: ethers.Wallet,
    joinerWallet: ethers.Wallet,
    hash
) {
    const appData = encodeHashLockedSwapData({ h: hash, preImage: '0x' });
    const channel: Channel = {
        chainId: ethers.utils.hexlify(chainId),
        channelNonce: 0, // this is the first channel between these participants on this chain
        participants: [proposerWallet.address, joinerWallet.address],
    };
    const outcome: AllocationAssetOutcome[] = [
        {
            assetHolderAddress,
            allocationItems: [
                {
                    destination: convertAddressToBytes32(
                        proposerWallet.address
                    ),
                    amount: SWAP_AMOUNT,
                },
                {
                    destination: convertAddressToBytes32(joinerWallet.address),
                    amount: '0x0',
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
    erc20AssetHolder: ethers.Contract,
    token: ethers.Contract,
    initialState: State,
    proposer: Actor,
    joiner: Actor
) {
    // Proposer proposes a channel with a hashlocked payment for the joiner
    const PreFund0 = signState(initialState, proposer.signingWallet.privateKey);
    const channelId = getChannelId(initialState.channel);
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
            if (
                !ethers.BigNumber.from(event.args.destinationHoldings).isZero()
            ) {
                // TODO check against the amount specified in the outcome on the state
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
        erc20AssetHolder.once('Deposited', listener);
    });

    // not shown: PreFund1 is delivered to joiner
    const _PostFund2: State = { ...initialState, turnNum: 2 };
    signState(_PostFund2, proposer.signingWallet.privateKey);
    proposer.log(
        `I have made my deposit, and send PostFund2 for chain ${initialState.channel.chainId}`
    );

    const value = (initialState.outcome[0] as AllocationAssetOutcome)
        .allocationItems[0].amount;

    // proposer increases the allowance of the ERC20Assetholder

    const tx0 = await token.increaseAllowance(erc20AssetHolder.address, value);
    const increaseAllowanceGas = await parseTransaction(
        token.provider,
        tx0,
        'increaseAllowance'
    );

    proposer.gasSpent += Number(increaseAllowanceGas);
    proposer.log(
        'spent ' + increaseAllowanceGas + ' gas increasing token allowance'
    );

    // Proposer funds channel (costs gas)

    const tx1 = await erc20AssetHolder.deposit(channelId, 0, value);
    const depositGas = await parseTransaction(token.provider, tx1, 'deposit');

    proposer.gasSpent += Number(depositGas);
    proposer.log('spent ' + depositGas + ' gas depositing tokens');

    await joinerToReactToDeposit;

    return channelId;
}

export async function defundChannel(
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
    const _isFinal5: State = { ...unlockState, isFinal: true };
    const isFinal5 = signState(_isFinal5, proposer.signingWallet.privateKey);
    // isFinal5 sent to joiner
    joiner.log('Countersigning...');
    const sigs = [
        isFinal5.signature,
        signState(_isFinal5, joiner.signingWallet.privateKey).signature,
    ];

    const concludedEvent = new Promise((resolve, reject) => {
        const listener = (from, to, amount, event) => {
            joiner.log(`Caught the Concluded event`);
            resolve(event);
        };
        nitroAdjudicator.once('Concluded', listener);
    });

    const tx = await nitroAdjudicator.concludePushOutcomeAndTransferAll(
        _isFinal5.turnNum,
        getFixedPart(_isFinal5),
        hashAppPart(_isFinal5),
        encodeOutcome(_isFinal5.outcome),
        1,
        [0, 0],
        sigs
    );
    const gasUsed = await parseTransaction(
        nitroAdjudicator.provider,
        tx,
        'concludePushOutcomeAndTransferAll'
    );
    joiner.gasSpent += Number(gasUsed);
    joiner.log(
        `Spent ${gasUsed} gas calling concludePushOutcomeAndTransferAll, total ${joiner.gasSpent}`
    );
    await concludedEvent;
}

export function swap(outcome: Outcome): Outcome {
    if (!('allocationItems' in outcome[0])) throw Error;
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

export async function fundChannelForDispute(
    erc20AssetHolder: ethers.Contract,
    token: ethers.Contract,
    initialState: State
) {
    const channelId = getChannelId(initialState.channel);
    const value = (initialState.outcome[0] as AllocationAssetOutcome)
        .allocationItems[0].amount;

    const { gasUsed: increaseAllowanceGas } = await (
        await token.increaseAllowance(erc20AssetHolder.address, value)
    ).wait();

    const { gasUsed: depositGas } = await (
        await erc20AssetHolder.deposit(channelId, 0, value)
    ).wait();

    return channelId;
}

export async function challengeChannel(
    nitroAdjudicator: ethers.Contract,
    challengeState1: State,
    challengeState2: State,
    alice: ethers.Wallet,
    bob: ethers.Wallet
) {
    const fixedPart = getFixedPart(challengeState1);
    const largestTurnNum = challengeState2.turnNum;
    const variableParts = [challengeState1, challengeState2].map(
        getVariablePart
    );
    const isFinalCount = 0;
    const whoSignedWhat = [1, 0];
    const signatures = [
        signState(challengeState2, alice.privateKey),
        signState(challengeState1, bob.privateKey),
    ].map((ss) => ss.signature);
    const challengeStateToSign: SignedState = {
        state: challengeState2,
        signature: { v: 0, r: '', s: '', _vs: '', recoveryParam: 0 },
    };
    const challengeSignature = signChallengeMessage(
        [challengeStateToSign],
        alice.privateKey
    );
    const { gasUsed } = await (
        await nitroAdjudicator.challenge(
            fixedPart,
            largestTurnNum,
            variableParts,
            isFinalCount,
            signatures,
            whoSignedWhat,
            challengeSignature
        )
    ).wait();
    console.log(`Gas used to challenge ${gasUsed}`);
}

export async function pushOutcomeAndTransferAll(
    chain: ethers.providers.JsonRpcProvider,
    nitroAdjudicator: ethers.Contract,
    challengeState: State,
    alice: ethers.Wallet
) {
    const channelId = getChannelId(getFixedPart(challengeState));
    const fingerprint = await nitroAdjudicator.unpackStatus(channelId);
    const turnNumberRecord = challengeState.turnNum;
    const finalizesAt = fingerprint[1];
    const stateHash = hashState(challengeState);
    const challengerAddress = alice.address;
    const outcomeBytes = encodeOutcome(challengeState.outcome);

    await advanceBlocktime(chain, 60);

    const { gasUsed } = await (
        await nitroAdjudicator.pushOutcomeAndTransferAll(
            channelId,
            turnNumberRecord,
            finalizesAt,
            stateHash,
            challengerAddress,
            outcomeBytes
        )
    ).wait();
    console.log(`Gas used for pushOutcomeAndTransferAll is ${gasUsed}`);
}
