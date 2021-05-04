import { BigNumber, Contract, ContractFactory, ethers } from 'ethers';
import { TestContractArtifacts } from '@statechannels/nitro-protocol';
import { artifacts, WithdrawCommitment } from '@connext/vector-contracts';
import {
    CoreChannelState,
    FullTransferState,
    HashlockTransferStateEncoding,
} from '@connext/vector-types';
import {
    ChannelSigner,
    createlockHash,
    createTestFullHashlockTransferState,
    encodeTransferResolver,
    encodeTransferState,
    generateMerkleTreeData,
    getRandomBytes32,
    hashCoreTransferState,
    hashTransferState,
    signChannelMessage,
} from '@connext/vector-utils';
import { solidityKeccak256 } from 'ethers/lib/utils';
import { ONE, SWAP_AMOUNT, ZERO } from '../constants';
import {
    Actor,
    advanceBlocktime,
    parseTransaction,
} from '../common/two-chain-setup';

export async function deployContractsToChain(
    chain: ethers.providers.JsonRpcProvider
) {
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

    const token = await ContractFactory.fromSolidity(
        TestContractArtifacts.TokenArtifact,
        deployer
    ).deploy(await chain.getSigner(0).getAddress());

    return [
        channelMasterCopy,
        channelFactory,
        hashLock,
        transferRegistry,
        token,
    ].map((contract) => contract.connect(chain.getSigner(0)));
}

/**
 * Send assets to the not-yet-deployed contract (As Bob)
 * @param chain
 * @param proposer
 * @param joiner
 * @param channelFactory
 * @param channelMasterCopy
 */
export async function fundChannel(
    chain: ethers.providers.JsonRpcProvider,
    proposer: Actor,
    joiner: Actor,
    channelFactory: Contract,
    channelMasterCopy: Contract,
    token?: Contract
) {
    const { chainId } = await chain.getNetwork();
    const channelAddress = ethers.utils.getCreate2Address(
        channelFactory.address,
        solidityKeccak256(
            ['address', 'address', 'uint256'],
            [
                proposer.signingWallet.address,
                joiner.signingWallet.address,
                chainId,
            ]
        ),
        solidityKeccak256(
            ['bytes'],
            [getMinimalProxyInitCode(channelMasterCopy.address)]
        )
    );

    const core: CoreChannelState = {
        nonce: 1,
        channelAddress: channelAddress, // depends on chainId
        // should have the to field filled out
        alice: joiner.signingWallet.address,
        bob: proposer.signingWallet.address,
        assetIds: [token.address],
        balances: [
            { amount: [SWAP_AMOUNT], to: [joiner.signingWallet.address] },
        ],
        processedDepositsA: [],
        processedDepositsB: [],
        defundNonces: [],
        timeout: (60 * 60 * 24 * 2).toString(), // 48 hrs is default,
        merkleRoot: '',
    };

    let gasUsed;
    if (token) {
        ({ gasUsed } = await (
            await token.transfer(channelAddress, core.balances[0].amount[0])
        ).wait());
    } else {
        ({ gasUsed } = await (
            await chain.getSigner().sendTransaction({
                to: channelAddress,
                value: core.balances[0].amount[0],
            })
        ).wait()); // Note that we ignore who *actually* sent the transaction, but attribute it to the proposer here
    }

    proposer.gasSpent += Number(gasUsed);
    proposer.log(
        `sent funds to contract on chain ${chainId}, spent ${gasUsed} gas`
    );
    return core;
}
/**
 * Create the multiSig and deposit (As Alice)
 * @param chain
 * @param proposer
 * @param joiner
 * @param channelFactory
 * @param channelMasterCopy
 */
export async function createAndFundChannel(
    chain: ethers.providers.JsonRpcProvider,
    proposer: Actor,
    joiner: Actor,
    channelFactory: Contract,
    channelMasterCopy: Contract,
    token?: Contract
) {
    const { chainId } = await chain.getNetwork();
    const channelAddress = ethers.utils.getCreate2Address(
        channelFactory.address,
        solidityKeccak256(
            ['address', 'address', 'uint256'],
            [
                proposer.signingWallet.address,
                joiner.signingWallet.address,
                chainId,
            ]
        ),
        solidityKeccak256(
            ['bytes'],
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
        alice: proposer.signingWallet.address,
        bob: joiner.signingWallet.address,
        assetIds: [token ? token.address : ethers.constants.AddressZero],
        balances: [
            { amount: [SWAP_AMOUNT], to: [joiner.signingWallet.address] },
        ],
        processedDepositsA: [],
        processedDepositsB: [],
        defundNonces: [],
        timeout: (60 * 60 * 24 * 2).toString(), // 48 hrs is default,
        merkleRoot: '',
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
    // Alice creates the multisig and deposits in one tx

    const { gasUsed: gasUsedForAllowance } = await (
        await token.increaseAllowance(
            channelFactory.address,
            core.balances[0].amount[0]
        )
    ).wait();

    proposer.gasSpent += Number(gasUsedForAllowance);
    proposer.log(
        `spent ${gasUsedForAllowance} gas increasing allownace for ChannelFactory`
    );

    const { gasUsed } = await (
        await channelFactory.createChannelAndDepositAlice(
            proposer.signingWallet.address,
            joiner.signingWallet.address,
            token ? token.address : ethers.constants.AddressZero,
            core.balances[0].amount[0]
        )
    ).wait(); // Note that we ignore who *actually* sent the transaction, but attribute it to the executor here
    // ideally we check that the new contract deployed at the address we expect

    proposer.gasSpent += Number(gasUsed);
    proposer.log(
        `called ChannelFactory.createChannelAndDepositAlice on chain ${chainId}, spent ${gasUsed} gas`
    );

    // TODO next Alice sends a deposit update in the channel. This is like a post fund setup (I think)
    // within vector client code, the amounts will be read off the chain
    return core;
}
/**
 * Withdraw funds from the multisig
 * @param chain
 * @param proposer
 * @param joiner
 * @param channelFactory
 * @param channelMasterCopy
 */
export async function defundChannel(
    channelAddress: string,
    proposer: Actor,
    joiner: Actor,
    chain: ethers.providers.JsonRpcProvider,
    gasPayer: Actor,
    token?: Contract
) {
    const { chainId } = await chain.getNetwork();
    const channel = await new Contract(
        channelAddress,
        artifacts.VectorChannel.abi,
        chain.getSigner(0)
    );

    const commitment = new WithdrawCommitment(
        channelAddress,
        proposer.signingWallet.address,
        joiner.signingWallet.address,
        joiner.signingWallet.address,
        token ? token.address : ethers.constants.AddressZero,
        SWAP_AMOUNT,
        '1'
    );

    const aliceSig = await new ChannelSigner(
        proposer.signingWallet.privateKey
    ).signMessage(commitment.hashToSign());
    const bobSig = await new ChannelSigner(
        joiner.signingWallet.privateKey
    ).signMessage(commitment.hashToSign());

    const withdrawData = commitment.getWithdrawData();

    const { gasUsed: gasUsed3 } = await (
        await channel.withdraw(withdrawData, aliceSig, bobSig)
    ).wait(); // once again we attribute the gas to the responder, even if they didn't call the function (they may not have ETH in this test)

    gasPayer.gasSpent += Number(gasUsed3);
    gasPayer.log(
        `called VectorChannel.withdraw on chain ${chainId} spent ${gasUsed3} gas, total ${gasPayer.gasSpent}`
    );
}
/**
 * Create2 the multisig and then withdraw funds from it
 * @param chain
 * @param proposer
 * @param joiner
 * @param channelFactory
 * @param channelMasterCopy
 */
export async function createAndDefundChannel(
    channelAddress: string,
    proposer: Actor,
    joiner: Actor,
    chain: ethers.providers.JsonRpcProvider,
    channelFactory: Contract,
    channelMasterCopy: Contract,
    token?: Contract
) {
    const { chainId } = await chain.getNetwork();

    const { gasUsed } = await (
        await channelFactory.createChannel(
            proposer.signingWallet.address,
            joiner.signingWallet.address
        )
    ).wait();

    joiner.gasSpent += Number(gasUsed);
    joiner.log(
        `called VectorChannel.createChannel on chain ${chainId} spent ${gasUsed} gas, total ${joiner.gasSpent}`
    );

    const channel = await new Contract(
        channelAddress,
        artifacts.VectorChannel.abi,
        chain.getSigner(0)
    );

    const commitment = new WithdrawCommitment(
        channelAddress,
        proposer.signingWallet.address,
        joiner.signingWallet.address,
        joiner.signingWallet.address,
        token ? token.address : ethers.constants.AddressZero,
        SWAP_AMOUNT,
        '1'
    );

    const aliceSig = await new ChannelSigner(
        proposer.signingWallet.privateKey
    ).signMessage(commitment.hashToSign());
    const bobSig = await new ChannelSigner(
        joiner.signingWallet.privateKey
    ).signMessage(commitment.hashToSign());

    const withdrawData = commitment.getWithdrawData();

    const { gasUsed: gasUsed3 } = await (
        await channel.withdraw(withdrawData, aliceSig, bobSig)
    ).wait(); // once again we attribute the gas to the responder, even if they didn't call the function (they may not have ETH in this test)

    joiner.gasSpent += Number(gasUsed3);
    joiner.log(
        `called VectorChannel.withdraw on chain ${chainId} spent ${gasUsed3} gas, total ${joiner.gasSpent}`
    );
}

// functions pulled out of @connext/vector-utils
export const getMinimalProxyInitCode = (mastercopyAddress: string): string =>
    `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${mastercopyAddress
        .toLowerCase()
        .replace(/^0x/, '')}5af43d82803e903d91602b57fd5bf3`;

/**
 * Dispute helpers
 */
export async function createAndFundChannelForDispute(
    chain: ethers.providers.JsonRpcProvider,
    alice: ethers.Wallet,
    bob: ethers.Wallet,
    channelFactory: Contract,
    channelMasterCopy: Contract,
    transferDefinition: Contract,
    token: Contract
) {
    const { chainId } = await chain.getNetwork();
    const channelAddress = ethers.utils.getCreate2Address(
        channelFactory.address,
        solidityKeccak256(
            ['address', 'address', 'uint256'],
            [alice.address, bob.address, chainId]
        ),
        solidityKeccak256(
            ['bytes'],
            [getMinimalProxyInitCode(channelMasterCopy.address)]
        )
    );

    const preImage = getRandomBytes32();
    const state = {
        lockHash: createlockHash(preImage),
        expiry: '0',
    };

    const transferState = createTestFullHashlockTransferState({
        initiator: alice.address,
        responder: bob.address,
        transferDefinition: transferDefinition.address,
        assetId: token.address,
        channelAddress,
        balance: { to: [alice.address, bob.address], amount: ['1', '0'] },
        transferState: state,
        transferResolver: { preImage },
        transferTimeout: '3',
        initialStateHash: hashTransferState(
            state,
            HashlockTransferStateEncoding
        ),
    });
    const { root: merkleRoot } = generateMerkleTreeData([transferState]);

    const core: CoreChannelState = {
        nonce: 1,
        channelAddress: channelAddress, // depends on chainId
        alice: alice.address,
        bob: bob.address,
        assetIds: [token.address],
        balances: [{ amount: [ZERO, ZERO], to: [alice.address, bob.address] }],
        processedDepositsA: [],
        processedDepositsB: [],
        defundNonces: [],
        timeout: (60 * 60 * 24 * 2).toString(), // 48 hrs is default,
        merkleRoot: merkleRoot,
    };

    const { gasUsed: gasUsedForAllowance } = await (
        await token.increaseAllowance(channelFactory.address, ONE)
    ).wait();

    const { gasUsed } = await (
        await channelFactory.createChannelAndDepositAlice(
            alice.address,
            bob.address,
            token.address,
            ONE
        )
    ).wait(); // Note that we ignore who *actually* sent the transaction, but attribute it to the executor here
    // ideally we check that the new contract deployed at the address we expect

    await (
        await chain.getSigner().sendTransaction({
            to: channelAddress,
            value: ONE,
        })
    ).wait(); // Note that we ignore who *actually* sent the transaction, but attribute it to the proposer here
    return { coreState: core, transferState };
}

export async function disputeChannel(
    chain: ethers.providers.JsonRpcProvider,
    coreState: CoreChannelState,
    aliceSignature: string,
    bobSignature: string
) {
    const { chainId } = await chain.getNetwork();
    const channel = await new Contract(
        coreState.channelAddress,
        artifacts.VectorChannel.abi,
        chain.getSigner(0)
    );
    const tx = await channel.disputeChannel(
        coreState,
        aliceSignature,
        bobSignature
    );

    await parseTransaction(chain, tx, 'dispute channel');
}

export async function disputeTransfer(
    chain: ethers.providers.JsonRpcProvider,
    coreState: CoreChannelState,
    transferState: FullTransferState
) {
    const { chainId } = await chain.getNetwork();
    const channel = await new Contract(
        transferState.channelAddress,
        artifacts.VectorChannel.abi,
        chain.getSigner(0)
    );
    await advanceBlocktime(chain, BigNumber.from(coreState.timeout).toNumber());

    const tx = await channel.disputeTransfer(
        transferState,
        getMerkleProof([transferState], transferState.transferId)
    );

    await parseTransaction(chain, tx, 'dispute transfer');
}

export async function defundTransfer(
    chain: ethers.providers.JsonRpcProvider,
    coreState: CoreChannelState,
    transferState: FullTransferState,
    alice: ethers.Wallet,
    bob: ethers.Wallet,
    token: Contract
) {
    const { chainId } = await chain.getNetwork();
    const channel = await new Contract(
        transferState.channelAddress,
        artifacts.VectorChannel.abi,
        chain.getSigner(0)
    );
    const defundTx = await channel.defundTransfer(
        transferState,
        encodeTransferState(
            transferState.transferState,
            transferState.transferEncodings[0]
        ),
        encodeTransferResolver(
            transferState.transferResolver,
            transferState.transferEncodings[1]
        ),
        await signChannelMessage(transferState.initialStateHash, bob.privateKey)
    );

    await parseTransaction(chain, defundTx, 'defund transfer');

    const exitTx = await channel.exit(
        transferState.assetId,
        transferState.balance.to[1],
        transferState.balance.to[1]
    );
    await parseTransaction(chain, exitTx, 'exit transfer');
}

// Copy pasted from https://github.com/connext/vector/blob/177b7adc615d6a70d3353bd3472c9040243c636f/modules/contracts/src.ts/tests/cmcs/adjudicator.spec.ts#L117
// Get merkle proof of transfer
function getMerkleProof(cts: FullTransferState[], toProve: string) {
    const { tree } = generateMerkleTreeData(cts);
    return tree.getHexProof(
        hashCoreTransferState(cts.find((t) => t.transferId === toProve)!)
    );
}
