import { artifacts } from "@connext/vector-contracts";
import { ContractFactory, ethers } from "ethers";
import { TestContractArtifacts } from "@statechannels/nitro-protocol";

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
