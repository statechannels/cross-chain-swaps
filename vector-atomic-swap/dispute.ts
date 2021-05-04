import { ethers } from 'ethers'

import { spinUpChains } from '../common/two-chain-setup'
import {
    deployContractsToChain,
    createAndFundChannelForDispute,
    disputeChannel,
    disputeTransfer,
    defundTransfer as defundTransferAndExit,
} from './helpers'
import { ChannelSigner, hashChannelCommitment } from '@connext/vector-utils'

const { leftChain: chain, tearDownChains } = spinUpChains()

/**
 * This function works through a dispute scenario and logs gas usage for each ethereum transaction.
 * The scenario is:
 * - The channel contains one transfer for a one token.
 * - Only the funds in the transfer are disputed/withdrawn.
 * - defundChannel is never called. defundChannel is usually called to withdraw funds not part of any transfers.
 */
async function dispute() {
    const alice = ethers.Wallet.createRandom()
    const bob = ethers.Wallet.createRandom()

    const aliceSigner = await new ChannelSigner(alice.privateKey)
    const bobSigner = await new ChannelSigner(bob.privateKey)

    const [
        masterCopy,
        channelFactory,
        hashLock,
        transferRegistry,
        token,
    ] = await deployContractsToChain(chain)

    const { coreState, transferState } = await createAndFundChannelForDispute(
        chain,
        alice,
        bob,
        channelFactory,
        masterCopy,
        hashLock,
        token
    )

    const aliceSignature = await aliceSigner.signMessage(
        hashChannelCommitment(coreState)
    )
    const bobSignature = await bobSigner.signMessage(
        hashChannelCommitment(coreState)
    )

    await disputeChannel(chain, coreState, aliceSignature, bobSignature)
    await disputeTransfer(chain, coreState, transferState)
    await defundTransferAndExit(
        chain,
        coreState,
        transferState,
        alice,
        bob,
        token
    )

    // teardown blockchains
    await tearDownChains()
    console.log('DONE!')
}

dispute()
