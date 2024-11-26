import { task } from "hardhat/config";
import axios from "axios";
import fs from "fs";
import path from "path";

task("esend-eth", "Sends ETH to a specified address and sends a confirmation email to the user")
  .addParam("useremail", "The email address of the user")
  .addParam("to", "The recipient address")
  .addParam("amount", "The amount of ETH to send")
  .setAction(async (taskArgs, hre) => {
    const { generateUnsignedUserOp, getUserOpHash } = require("../scripts/utils/userOpUtils"); // lazy import to avoid circular dependency
    let { useremail, to, amount } = taskArgs;

    amount = hre.ethers.parseEther(amount);

    // Load entryPointAddress from deployedAddresses/EmailAccountFactory.json
    const deployedAddressesPath = path.join(__dirname, "../deployedAddresses/EmailAccountFactory.json");
    const deployedAddresses = JSON.parse(fs.readFileSync(deployedAddressesPath, "utf8"));
    const entryPointAddress = deployedAddresses.entryPointAddress;
    const factoryAddress = deployedAddresses.factoryAddress;
    if (!entryPointAddress) {
      throw new Error("Entry point address not found in deployedAddresses/EmailAccountFactory.json");
    }

    // take node bundler and node provider from environment variables
    const bundlerProvider = new hre.ethers.JsonRpcProvider(process.env.BUNDLER_URL!);
    const provider = new hre.ethers.JsonRpcProvider(process.env.NODE_URL!);

    const executeFunctionSelector = "0x" + hre.ethers.id("execute(address,uint256,bytes)").slice(2, 10);
    const callData = executeFunctionSelector + hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes"],
      [to, amount, "0x"]
    ).slice(2);

    // create a temporary email account using the deployed factory address
    const EmailAccountFactory = await hre.ethers.getContractAt("EmailAccountFactory", factoryAddress);
    const randomAccountCode = BigInt(Math.floor(Math.random() * 10 ** 20));
    await EmailAccountFactory.createEmailAccount(randomAccountCode);
    const emailAccountAddress = await EmailAccountFactory.computeAddress(randomAccountCode);

    // set balance to 100 ETH through provider
    await provider.send("hardhat_setBalance", [emailAccountAddress, hre.ethers.parseEther("100").toString()]);

    // get current balance of email account
    const balance = await provider.getBalance(emailAccountAddress);

    const unsignedUserOperation = await generateUnsignedUserOp(
      entryPointAddress,
      provider,
      bundlerProvider,
      emailAccountAddress,
      callData
    );
    const userOpHash = getUserOpHash(unsignedUserOperation, entryPointAddress, hre.network.config.chainId!);
    unsignedUserOperation.userOpHash = userOpHash;
    unsignedUserOperation.accountCode = randomAccountCode.toString();

    // remove the dummy signature
    delete unsignedUserOperation.signature;

    // Serialize user operation
    const serializedUserOp = JSON.stringify(unsignedUserOperation);

    console.log("serializedUserOp", serializedUserOp);

    const emailData = {
      to: useremail,
      subject: `Confirm Your ETH Transaction - Reference: ${userOpHash.slice(0, 8)}`,
      body_plain: `Please confirm your ETH transaction.`,
      body_html: `<html><body style="font-family: Arial, sans-serif; color: #333;">
        <div style="max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
          <h2 style="color: #4CAF50;">Hello,</h2>
          <p>You have initiated a transaction to send <strong>${hre.ethers.formatEther(amount)} ETH</strong> to <strong>${to}</strong>.</p>
          <p>Your current ETH balance is <strong>${hre.ethers.formatEther(balance)} ETH</strong>.</p>
          <p>This email wallet has been generated with a random account code on demand for you, ideal for easy testing.</p>
          <p>Please reply to this email to confirm the transaction.</p>
          <p>Best regards,<br><strong>Email Wallet</strong></p>
          <p><a href="${process.env.SCANNER_URL}/address/${emailAccountAddress}" style="color: #4CAF50;">View your account on the scanner</a></p>
        </div>
        <div style="display: none;" id="userOp">${JSON.stringify(JSON.parse(serializedUserOp), null, 2)}</div>
      </body></html>`,
      reference: null,
      reply_to: null,
      body_attachments: null,
    };

    try {
      const response = await axios.post(process.env.EMAIL_API_URL!, emailData, {
        headers: {
          "Content-Type": "application/json",
        },
      });
      const messageId = response.data.message_id;
      console.log("Email sent with message ID: " + messageId);
      console.log("Email sent: " + JSON.stringify(response.data));
    } catch (error) {
      console.error("Error sending email: " + error);
    }
  });