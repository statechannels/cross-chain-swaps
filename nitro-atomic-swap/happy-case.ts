import { ethers } from 'ethers'
import { State, signState } from '@statechannels/nitro-protocol'
import { LEFT_CHAIN_ID, RIGHT_CHAIN_ID } from '../constants'
import {
    Executor,
    logBalances,
    logTotalGasSpentByAll,
    Responder,
    spinUpChains,
} from '../common/two-chain-setup'
import { deployContractsToChain } from './helpers'
import {
    createHashLockChannel,
    fundChannel,
    preImage,
    correctPreImage,
    decodeHashLockedSwapData,
    defundChannel,
    encodeHashLockedSwapData,
    swap,
} from './helpers'

const { leftChain, rightChain, tearDownChains } = spinUpChains()

// Spin up two instances of ganache.
// Deploy NitroAdjudicator, ERC20AssetHolder, HashLock to both instances
// Run an atomic swap between the chains (Happy Case, Direct Funding)
// Record time taken and gas consumed
// Explore unhappy cases
// Explore off-chain funding use case

// *****

;(async function () {
    // SETUP CONTRACTS ON BOTH CHAINS
    // Deploy the contracts to chain, and then reconnect them to their respective signers
    // for the rest of the interactions
    const [
        leftNitroAdjudicator,
        leftERC20AssetHolder,
        leftHashLock,
        leftToken,
    ] = await deployContractsToChain(leftChain)
    const [
        rightNitroAdjudicator,
        rightERC20AssetHolder,
        rightHashLock,
        rightToken,
    ] = await deployContractsToChain(rightChain)

    const executor = new Executor(leftToken, rightToken)
    const responder = new Responder(leftToken, rightToken)

    await logBalances(executor, responder)

    const _PreFund0 = createHashLockChannel(
        LEFT_CHAIN_ID,
        60,
        leftHashLock.address,
        leftERC20AssetHolder.address,
        executor.signingWallet,
        responder.signingWallet,
        ethers.utils.sha256(preImage)
    )

    // exchanges setup states and funds on left chain
    const longChannel = await fundChannel(
        leftERC20AssetHolder,
        leftToken,
        _PreFund0,
        executor,
        responder
    )

    // given the longChannel is now funded and running
    // the responder needs to incentivize the executor to do the swap
    const _preFund0 = createHashLockChannel(
        RIGHT_CHAIN_ID,
        30,
        rightHashLock.address,
        rightERC20AssetHolder.address,
        responder.signingWallet,
        executor.signingWallet,
        decodeHashLockedSwapData(_PreFund0.appData).h
    )

    const shortChannel = await fundChannel(
        rightERC20AssetHolder,
        rightToken,
        _preFund0,
        responder,
        executor
    )

    // await logBalances(executor, responder); // uncomment this to check deposit was legit

    // executor unlocks payment that benefits him
    const _unlock4: State = {
        ..._preFund0,
        turnNum: 4,
        appData: encodeHashLockedSwapData(correctPreImage),
        outcome: swap(_preFund0.outcome),
    }
    const unlock4 = signState(_unlock4, executor.signingWallet.privateKey)

    // responder decodes the preimage and unlocks the payment that benefits her
    const decodedPreImage = decodeHashLockedSwapData(unlock4.state.appData)
        .preImage
    const decodedHash = decodeHashLockedSwapData(unlock4.state.appData).h
    const _Unlock4: State = {
        ..._PreFund0,
        turnNum: 4,
        appData: encodeHashLockedSwapData({
            h: decodedHash,
            preImage: decodedPreImage,
        }),
        outcome: swap(_PreFund0.outcome),
    }
    const Unlock4 = signState(_Unlock4, responder.signingWallet.privateKey)

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
    ])

    await logBalances(executor, responder)
    logTotalGasSpentByAll(executor, responder)

    // teardown blockchains
    await tearDownChains()
})()
