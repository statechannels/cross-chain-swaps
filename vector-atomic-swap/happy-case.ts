import { ethers } from 'ethers'
import { CoreTransferState } from '@connext/vector-types'

import {
    Actor,
    Executor,
    Responder,
    spinUpChains,
    logBalances,
    logTotalGasSpentByAll,
} from '../common/two-chain-setup'
import {
    deployContractsToChain,
    fundChannel,
    createAndFundChannel,
    createAndDefundChannel,
    defundChannel,
} from './helpers'

const { leftChain, rightChain, tearDownChains } = spinUpChains()

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

;(async function () {
    // SETUP CONTRACTS ON BOTH CHAINS
    // Deploy the contracts to chain, and then reconnect them to their respective signers
    // for the rest of the interactions
    const [
        leftChannelMasterCopy,
        leftChannelFactory,
        leftHashLock,
        leftTransferRegistry,
        leftToken,
    ] = await deployContractsToChain(leftChain)
    const [
        rightChannelMasterCopy,
        rightChannelFactory,
        rightHashLock,
        rightTransferRegistry,
        rightToken,
    ] = await deployContractsToChain(rightChain)

    const executor = new Executor(leftToken, rightToken)
    const responder = new Responder(leftToken, rightToken)
    await logBalances(executor, responder)

    const leftCore = await fundChannel(
        leftChain,
        executor,
        responder,
        leftChannelFactory,
        leftChannelMasterCopy,
        leftToken
    )

    const leftConditionalTransfer: CoreTransferState = {
        channelAddress: leftCore.channelAddress,
        transferId: 'todo',
        transferDefinition: leftHashLock.address,
        initiator: executor.signingWallet.address,
        responder: responder.signingWallet.address,
        assetId: ethers.constants.HashZero,
        balance: { amount: ['0x1'], to: [executor.signingWallet.address] },
        transferTimeout: leftCore.timeout,
        initialStateHash: ethers.constants.HashZero, // TODO
    }

    // TODO sign and send this state.

    const rightCore = await createAndFundChannel(
        rightChain,
        responder,
        executor,
        rightChannelFactory,
        rightChannelMasterCopy,
        rightToken
    )

    // given the longChannel is now funded and running
    // the responder needs to incentivize the executor to do the swap
    // TODO sign and send a rightConditionalTransfer

    // TODO
    // executor unlocks payment that benefits him
    // responder decodes the preimage and unlocks the payment that benefits her
    // both channels are collaboratively defunded

    // Now we want to withdraw on both chains
    await createAndDefundChannel(
        leftCore.channelAddress,
        executor,
        responder,
        leftChain,
        leftChannelFactory,
        leftChannelMasterCopy,
        leftToken
    )
    await defundChannel(
        rightCore.channelAddress,
        responder,
        executor,
        rightChain,
        responder,
        rightToken
    )

    await logBalances(executor, responder)
    logTotalGasSpentByAll(executor, responder)

    // teardown blockchains
    await tearDownChains()
})()
