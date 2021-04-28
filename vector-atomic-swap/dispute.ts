import { ethers } from "ethers";

import { spinUpChains } from "../common/two-chain-setup";
import {
  deployContractsToChain,
  createAndFullyFundChannel,
  disputeChannel,
  disputeTransfer,
} from "./helpers";
import {
  ChannelSigner,
  hashChannelCommitment,
  hashCoreChannelState,
} from "@connext/vector-utils";

const { leftChain: chain, tearDownChains } = spinUpChains();

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

async function main() {
  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();

  const aliceSigner = await new ChannelSigner(alice.privateKey);
  const bobSigner = await new ChannelSigner(bob.privateKey);

  // SETUP CONTRACTS ON BOTH CHAINS
  // Deploy the contracts to chain, and then reconnect them to their respective signers
  // for the rest of the interactions
  const [
    masterCopy,
    channelFactory,
    hashLock,
    transferRegistry,
    token,
  ] = await deployContractsToChain(chain);

  const { coreState, transferState } = await createAndFullyFundChannel(
    chain,
    alice,
    bob,
    channelFactory,
    masterCopy,
    hashLock,
    token,
  );

  const aliceSignature = await aliceSigner.signMessage(
    hashChannelCommitment(coreState),
  );
  const bobSignature = await bobSigner.signMessage(
    hashChannelCommitment(coreState),
  );

  await disputeChannel(chain, coreState, aliceSignature, bobSignature);
  await disputeTransfer(chain, coreState, transferState);

  // teardown blockchains
  await tearDownChains();
  console.log("DONE!");
}

main();
