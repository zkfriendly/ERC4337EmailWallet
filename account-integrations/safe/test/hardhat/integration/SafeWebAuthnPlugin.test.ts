import hre from "hardhat";
import { expect } from "chai";
import { AddressZero } from "@ethersproject/constants";
import { concat, ethers, BigNumberish } from "ethers";
import { UserOperationStruct } from "@account-abstraction/contracts";
import { calculateProxyAddress } from "../utils/calculateProxyAddress";
import {
  SafeProxyFactory__factory,
  Safe__factory,
} from "../../../typechain-types";
import sendUserOpAndWait from "../utils/sendUserOpAndWait";

const ERC4337_TEST_ENV_VARIABLES_DEFINED =
  typeof process.env.ERC4337_TEST_BUNDLER_URL !== "undefined" &&
  typeof process.env.ERC4337_TEST_NODE_URL !== "undefined" &&
  typeof process.env.ERC4337_TEST_SAFE_FACTORY_ADDRESS !== "undefined" &&
  typeof process.env.ERC4337_TEST_SINGLETON_ADDRESS !== "undefined" &&
  typeof process.env.MNEMONIC !== "undefined";

const itif = ERC4337_TEST_ENV_VARIABLES_DEFINED ? it : it.skip;
const SAFE_FACTORY_ADDRESS = process.env.ERC4337_TEST_SAFE_FACTORY_ADDRESS;
const SINGLETON_ADDRESS = process.env.ERC4337_TEST_SINGLETON_ADDRESS;
const BUNDLER_URL = process.env.ERC4337_TEST_BUNDLER_URL;
const NODE_URL = process.env.ERC4337_TEST_NODE_URL;
const MNEMONIC = process.env.MNEMONIC;

describe("SafeWebAuthnPlugin", () => {
  const setupTests = async () => {
    const bundlerProvider = new ethers.JsonRpcProvider(BUNDLER_URL);
    const provider = new ethers.JsonRpcProvider(NODE_URL);
    const userWallet = ethers.Wallet.fromPhrase(MNEMONIC!).connect(provider);

    const entryPoints = (await bundlerProvider.send(
      "eth_supportedEntryPoints",
      [],
    )) as string[];
    if (entryPoints.length === 0) {
      throw new Error("No entry points found");
    }

    if (!SAFE_FACTORY_ADDRESS) {
      throw new Error("No Safe factory address found");
    }

    if (!SINGLETON_ADDRESS) {
      throw new Error("No Safe singleton address found");
    }

    return {
      factory: SafeProxyFactory__factory.connect(
        SAFE_FACTORY_ADDRESS,
        userWallet,
      ),
      singleton: Safe__factory.connect(SINGLETON_ADDRESS, provider),
      bundlerProvider,
      provider,
      userWallet,
      entryPoints,
    };
  };

  const getPublicKeyAndSignature = () => {
    const publicKey: [BigNumberish, BigNumberish] = [
      BigInt(
        "84983235508986227069118519878575107221347312419117152995971180204793547896817",
      ),
      BigInt(
        "65342283463016373417889909198331793507107976344099657471582098851386861908802",
      ),
    ];

    const authenticatorData =
      "0x1584482fdf7a4d0b7eb9d45cf835288cb59e55b8249fff356e33be88ecc546d11d00000000";
    const authenticatorDataFlagMask = "0x01";
    const clientData =
      "0x7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22efbfbd22efbfbd5f21efbfbd1b113e63efbfbdefbfbd6defbfbd4fefbfbdefbfbd11efbfbd11efbfbd40efbfbdefbfbdefbfbd64efbfbdefbfbd3cefbfbd58222c226f726967696e223a2268747470733a2f2f646576656c6f706d656e742e666f72756d64616f732e636f6d227d";
    const clientChallengeDataOffset = 36;
    const signature: [BigNumberish, BigNumberish] = [
      BigInt(
        "36788204816852931931532076736929768488646494203674172515272861180041446565109",
      ),
      BigInt(
        "60595451626159535380360537025565143491223093262105891867977188941268073626113",
      ),
    ];

    const encoder = new ethers.AbiCoder();
    const userOpSignature = encoder.encode(
      ["bytes", "bytes1", "bytes", "uint256", "uint256[2]", "uint256[2]"],
      [
        authenticatorData,
        authenticatorDataFlagMask,
        clientData,
        clientChallengeDataOffset,
        signature,
        publicKey,
      ],
    );

    return { publicKey, userOpSignature };
  };

  /**
   * This test verifies a ERC4337 transaction succeeds when sent via a plugin
   * The user operation deploys a Safe with the ERC4337 plugin and a handler
   * and executes a transaction, thus verifying two things:
   * 1. Deployment of the Safe with the ERC4337 plugin and handler is possible
   * 2. Executing a transaction is possible
   */
  itif("should pass the ERC4337 validation", async () => {
    const {
      singleton,
      factory,
      provider,
      bundlerProvider,
      userWallet,
      entryPoints,
    } = await setupTests();
    const { publicKey, userOpSignature } = getPublicKeyAndSignature();
    const ENTRYPOINT_ADDRESS = entryPoints[0];

    const safeWebAuthnPluginFactory = (
      await hre.ethers.getContractFactory("SafeWebAuthnPlugin")
    ).connect(userWallet);
    const safeWebAuthnPlugin = await safeWebAuthnPluginFactory.deploy(
      ENTRYPOINT_ADDRESS,
      publicKey,
      { gasLimit: 2_000_000 },
    );
    await safeWebAuthnPlugin.deploymentTransaction()?.wait();

    const feeData = await provider.getFeeData();
    if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
      throw new Error(
        "maxFeePerGas or maxPriorityFeePerGas is null or undefined",
      );
    }

    const maxFeePerGas = `0x${feeData.maxFeePerGas.toString()}`;
    const maxPriorityFeePerGas = `0x${feeData.maxPriorityFeePerGas.toString()}`;

    const safeWebAuthnPluginAddress = await safeWebAuthnPlugin.getAddress();
    const singletonAddress = await singleton.getAddress();
    const factoryAddress = await factory.getAddress();

    const moduleInitializer =
      safeWebAuthnPlugin.interface.encodeFunctionData("enableMyself");
    const encodedInitializer = singleton.interface.encodeFunctionData("setup", [
      [userWallet.address],
      1,
      safeWebAuthnPluginAddress,
      moduleInitializer,
      safeWebAuthnPluginAddress,
      AddressZero,
      0,
      AddressZero,
    ]);

    const deployedAddress = await calculateProxyAddress(
      factory,
      singletonAddress,
      encodedInitializer,
      73,
    );

    // The initCode contains 20 bytes of the factory address and the rest is the
    // calldata to be forwarded
    const initCode = concat([
      factoryAddress,
      factory.interface.encodeFunctionData("createProxyWithNonce", [
        singletonAddress,
        encodedInitializer,
        73,
      ]),
    ]);

    const signer = new ethers.Wallet(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const recipientAddress = signer.address;
    const transferAmount = ethers.parseEther("1");

    const userOpCallData = safeWebAuthnPlugin.interface.encodeFunctionData(
      "execTransaction",
      [recipientAddress, transferAmount, "0x00"],
    );

    // Native tokens for the pre-fund 💸
    await (
      await userWallet.sendTransaction({
        to: deployedAddress,
        value: ethers.parseEther("100"),
      })
    ).wait();

    const userOperationWithoutGasFields = {
      sender: deployedAddress,
      nonce: "0x0",
      initCode,
      callData: userOpCallData,
      callGasLimit: "0x00",
      paymasterAndData: "0x",
      signature: userOpSignature,
    };

    const gasEstimate = (await bundlerProvider.send(
      "eth_estimateUserOperationGas",
      [userOperationWithoutGasFields, ENTRYPOINT_ADDRESS],
    )) as {
      verificationGasLimit: string;
      preVerificationGas: string;
      callGasLimit: string;
    };

    const safeVerificationGasLimit =
      BigInt(gasEstimate.verificationGasLimit) +
      BigInt(gasEstimate.verificationGasLimit) / 10n; // + 10%

    const safePreVerificationGas =
      BigInt(gasEstimate.preVerificationGas) +
      BigInt(gasEstimate.preVerificationGas) / 50n; // + 2%

    const userOperation: UserOperationStruct = {
      sender: deployedAddress,
      nonce: "0x0",
      initCode,
      callData: userOpCallData,
      callGasLimit: gasEstimate.callGasLimit,
      verificationGasLimit: ethers.toBeHex(safeVerificationGasLimit),
      preVerificationGas: ethers.toBeHex(safePreVerificationGas),
      maxFeePerGas,
      maxPriorityFeePerGas,
      paymasterAndData: "0x",
      signature: userOpSignature,
    };

    // Uncomment to get a detailed debug message
    // const DEBUG_MESSAGE = `
    //         Using entry point: ${ENTRYPOINT_ADDRESS}
    //         Deployed Safe address: ${deployedAddress}
    //         Module/Handler address: ${safeWebAuthnPluginAddress}
    //         User operation:
    //         ${JSON.stringify(userOperation, null, 2)}
    //     `;
    // console.log(DEBUG_MESSAGE);

    const recipientBalanceBefore = await provider.getBalance(recipientAddress);

    await sendUserOpAndWait(userOperation, ENTRYPOINT_ADDRESS, bundlerProvider);

    const recipientBalanceAfter = await provider.getBalance(recipientAddress);

    const expectedRecipientBalance = recipientBalanceBefore + transferAmount;
    expect(recipientBalanceAfter).to.equal(expectedRecipientBalance);
  });
});
