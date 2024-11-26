import { ethers } from "hardhat";
import { JsonRpcProvider, Signer } from "ethers";
import {
  EmailAccount,
  EmailAccountDummyVerifier,
  HMockDkimRegistry,
} from "../typechain";
import { eSign, mockProver } from "../scripts/utils/prover";
import { generateUnsignedUserOp } from "../scripts/utils/userOpUtils";
import sendUserOpAndWait, {
  createUserOperation,
  getUserOpHash,
} from "../scripts/utils/userOpUtils";
import { expect } from "chai";

describe("EmailAccountTest", () => {
  let context: {
    bundlerProvider: JsonRpcProvider;
    provider: JsonRpcProvider;
    admin: Signer;
    owner: Signer;
    entryPointAddress: string;
  };

  let verifier: EmailAccountDummyVerifier;
  let dkimRegistry: HMockDkimRegistry;
  let emailAccount: EmailAccount;
  let owner: Signer;
  let recipient: Signer;
  let recipientAddress: string;
  let domainPubKeyHash: bigint;
  let accountCommitment: bigint;

  const p = BigInt(
    "21888242871839275222246405745257275088548364400416034343698204186575808495617"
  );
  const transferAmount = ethers.parseEther("1");

  async function setupTests() {
    const [admin, owner] = await ethers.getSigners();
    const provider = new ethers.JsonRpcProvider("http://localhost:8545");
    const bundlerProvider = new ethers.JsonRpcProvider(
      "http://localhost:3000/rpc"
    );

    // get list of supported entrypoints
    const entrypoints = await bundlerProvider.send(
      "eth_supportedEntryPoints",
      []
    );

    if (entrypoints.length === 0) {
      throw new Error("No entrypoints found");
    }

    return {
      bundlerProvider,
      provider,
      admin,
      owner,
      recipient,
      entryPointAddress: entrypoints[0],
    };
  }

  before(async () => {
    context = await setupTests();
    [owner, recipient] = await ethers.getSigners();

    recipientAddress = await recipient.getAddress();
    const verifierFactory = await ethers.getContractFactory(
      "EmailAccountDummyVerifier"
    );
    verifier = await verifierFactory.deploy();

    const dkimRegistryFactory = await ethers.getContractFactory(
      "HMockDkimRegistry"
    );
    dkimRegistry = await dkimRegistryFactory.deploy();

    domainPubKeyHash =
      BigInt(ethers.keccak256(ethers.toUtf8Bytes("sample_dkim_pubkey"))) %
      BigInt(p);
    accountCommitment =
      BigInt(
        ethers.keccak256(ethers.toUtf8Bytes("sample_account_commitment"))
      ) % BigInt(p);

    const factory = await ethers.getContractFactory("EmailAccountFactory");
    const emailAccountFactory = await factory.deploy(
      context.entryPointAddress,
      await verifier.getAddress(),
      await dkimRegistry.getAddress()
    );
    await emailAccountFactory.waitForDeployment();

    // deploy the email account using the factory
    await emailAccountFactory.createEmailAccount(accountCommitment);
    emailAccount = await ethers.getContractAt("EmailAccount", await emailAccountFactory.computeAddress(accountCommitment));

    // fund the account
    await context.provider.send("hardhat_setBalance", [
      await emailAccount.getAddress(),
      ethers.parseEther("1000").toString(),
    ]);
  });

  it("should load the mock prover", async () => {
    const input = {
      userOpHashIn: "0x0",
      emailCommitmentIn: "0x1",
      pubkeyHashIn: "0x2",
    };

    const { proof, publicSignals, solidityCalldata } = await mockProver(input);

    const factory = await ethers.getContractFactory(
      "EmailAccountDummyVerifier"
    );
    const verifier = await factory.deploy();

    const result = await verifier.verifyProof(
      solidityCalldata[0],
      solidityCalldata[1],
      solidityCalldata[2],
      publicSignals
    );

    expect(result).to.be.true;
    expect(proof).to.exist;
    expect(publicSignals).to.exist;
    expect(publicSignals).to.deep.equal(Object.values(input));
  });

  it("should execute a simple ETH transfer", async () => {
    await assertSendEth(transferAmount);
  });

  it("should send 2 more eth twice", async () => {
    await assertSendEth(ethers.parseEther("2"));
    await assertSendEth(ethers.parseEther("2"));
  });

  it("should not be able to reuse the same signature on similar userOps", async () => {
    const callData = emailAccount.interface.encodeFunctionData("execute", [
      recipientAddress,
      transferAmount,
      "0x",
    ]);
    const userOp1 = await prepareUserOp(callData);
    const userOp2 = await createUserOperation(
      context.provider,
      context.bundlerProvider,
      await emailAccount.getAddress(),
      { factory: "0x", factoryData: "0x" },
      callData,
      context.entryPointAddress,
      userOp1.signature
    );

    await sendUserOpAndWait(
      userOp1,
      context.entryPointAddress,
      context.bundlerProvider
    );
    expect(
      sendUserOpAndWait(
        userOp2,
        context.entryPointAddress,
        context.bundlerProvider
      )
    ).to.be.rejected;
  });

  it("should send eth with a different valid domain pubkey hash", async () => {
    domainPubKeyHash =
      BigInt(ethers.keccak256(ethers.toUtf8Bytes("sample_dkim_pubkey_2"))) %
      BigInt(p); // will reset on each test case
    await assertSendEth(transferAmount);
  });

  it("should be able to still use the old valid domain pubkey hash", async () => {
    await assertSendEth(transferAmount);
  });

  it("should not fail to transfer on first tx after new valid domain pubkey hash", async () => {
    domainPubKeyHash =
      BigInt(ethers.keccak256(ethers.toUtf8Bytes("sample_dkim_pubkey_3"))) %
      BigInt(p);
    await assertSendEth(transferAmount);
  });

  it("should not fail to transfer on second tx after new valid domain pubkey hash", async () => {
    domainPubKeyHash =
      BigInt(ethers.keccak256(ethers.toUtf8Bytes("sample_dkim_pubkey_3"))) %
      BigInt(p);
    await assertSendEth(transferAmount);
  });

  it("should fail with invalid domain pubkey hash", async () => {
    domainPubKeyHash = BigInt(5); // means that the domain pubkey hash is invalid
    await expect(assertSendEth(transferAmount)).to.be.rejected; // todo: rejects because it has invalid domain pubkey hash
  });

  it("should fail with invalid account commitment", async () => {
    accountCommitment = BigInt(5); // means that the account commitment is invalid
    await expect(assertSendEth(transferAmount)).to.be.rejected;
  });

  async function prepareUserOp(callData: string) {
    const unsignedUserOperation = await generateUnsignedUserOp(
      context.entryPointAddress,
      context.provider,
      context.bundlerProvider,
      await emailAccount.getAddress(),
      callData
    );
    return await signUserOp(unsignedUserOperation);
  }

  async function signUserOp(unsignedUserOperation: any) {
    const chainId = await context.provider
      .getNetwork()
      .then((network) => network.chainId);
    const userOpHash = getUserOpHash(
      unsignedUserOperation,
      context.entryPointAddress,
      Number(chainId)
    );

    // sign the userOp
    unsignedUserOperation.signature = await eSign({
      hash: userOpHash,
      senderEmail: recipientAddress,
      senderAccountCode: accountCommitment.toString(),
    });

    return unsignedUserOperation;
  }

  async function assertSendEth(amount: bigint) {
    const recipientBalanceBefore = await context.provider.getBalance(
      recipientAddress
    );

    const executeFunctionSelector = "0x" + ethers.id("execute(address,uint256,bytes)").slice(2, 10);
    const callData = executeFunctionSelector + ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes"],
      [recipientAddress, amount, "0x"]
    ).slice(2);

    const userOp = await prepareUserOp(callData);
    await sendUserOpAndWait(
      userOp,
      context.entryPointAddress,
      context.bundlerProvider
    );
    const recipientBalanceAfter = await context.provider.getBalance(
      recipientAddress
    );
    const expectedRecipientBalance = recipientBalanceBefore + amount;
    expect(recipientBalanceAfter).to.equal(expectedRecipientBalance);
  }
});
