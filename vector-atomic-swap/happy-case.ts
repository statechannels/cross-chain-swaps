import { Contract, ethers } from "ethers";

import { artifacts, WithdrawCommitment } from "@connext/vector-contracts";
import { CoreChannelState, CoreTransferState } from "@connext/vector-types";
import { ChannelSigner } from "@connext/vector-utils";
import { solidityKeccak256 } from "ethers/lib/utils";
import { SWAP_AMOUNT } from "../constants";
import {
  Actor,
  Executor,
  Responder,
  spinUpChains,
  logBalances,
} from "../common/two-chain-setup";
import { deployContractsToChain } from "./helpers";

const {
  executorWallet,
  responderWallet,
  deployerWallet,
  leftChain,
  rightChain,
  tearDownChains,
} = spinUpChains();

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

(async function () {
  // SETUP CONTRACTS ON BOTH CHAINS
  // Deploy the contracts to chain, and then reconnect them to their respective signers
  // for the rest of the interactions
  const [
    leftChannelMasterCopy,
    leftChannelFactory,
    leftHashLock,
    leftTransferRegistry,
    leftToken,
  ] = await deployContractsToChain(leftChain);
  const [
    rightChannelMasterCopy,
    rightChannelFactory,
    rightHashLock,
    rightTransferRegistry,
    rightToken,
  ] = await deployContractsToChain(rightChain);

  const executor = new Executor(leftToken, rightToken);
  const responder = new Responder(leftToken, rightToken);
  await logBalances(executor, responder);

  const leftCore = await fundChannel(
    leftChain,
    executor,
    responder,
    leftChannelFactory,
    leftChannelMasterCopy,
    leftToken
  );

  const leftConditionalTransfer: CoreTransferState = {
    channelAddress: leftCore.channelAddress,
    transferId: "todo",
    transferDefinition: leftHashLock.address,
    initiator: executorWallet.address,
    responder: responderWallet.address,
    assetId: ethers.constants.HashZero,
    balance: { amount: ["0x1"], to: [executorWallet.address] },
    transferTimeout: leftCore.timeout,
    initialStateHash: ethers.constants.HashZero, // TODO
  };

  // TODO sign and send this state.

  const rightCore = await createAndFundChannel(
    rightChain,
    responder,
    executor,
    rightChannelFactory,
    rightChannelMasterCopy,
    rightToken
  );

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
  );
  await defundChannel(
    rightCore.channelAddress,
    responder,
    executor,
    rightChain,
    responder,
    rightToken
  );

  await logBalances(executor, responder);

  // teardown blockchains
  await tearDownChains();
})();

/**
 * Send assets to the not-yet-deployed contract (As Bob)
 * @param chain
 * @param proposer
 * @param joiner
 * @param channelFactory
 * @param channelMasterCopy
 */
async function fundChannel(
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
      ["address", "address", "uint256"],
      [proposer.signingWallet.address, joiner.signingWallet.address, chainId]
    ),
    solidityKeccak256(
      ["bytes"],
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
    balances: [{ amount: [SWAP_AMOUNT], to: [responderWallet.address] }],
    processedDepositsA: [],
    processedDepositsB: [],
    defundNonces: [],
    timeout: (60 * 60 * 24 * 2).toString(), // 48 hrs is default,
    merkleRoot: "",
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
async function createAndFundChannel(
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
      ["address", "address", "uint256"],
      [proposer.signingWallet.address, joiner.signingWallet.address, chainId]
    ),
    solidityKeccak256(
      ["bytes"],
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
    balances: [{ amount: [SWAP_AMOUNT], to: [responderWallet.address] }],
    processedDepositsA: [],
    processedDepositsB: [],
    defundNonces: [],
    timeout: (60 * 60 * 24 * 2).toString(), // 48 hrs is default,
    merkleRoot: "",
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
async function defundChannel(
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
    "1"
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
async function createAndDefundChannel(
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
    "1"
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
    .replace(/^0x/, "")}5af43d82803e903d91602b57fd5bf3`;
