import { ethers } from "ethers";
import * as snarkjs from "snarkjs";

export async function mockProver(input: any) {
  // Load the circuit
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    "scripts/utils/prover/mock/main.wasm",
    "scripts/utils/prover/mock/groth16_pkey.zkey"
  );

  let solidityCalldata = await snarkjs.groth16.exportSolidityCallData(
    proof,
    publicSignals
  );
  solidityCalldata = JSON.parse("[" + solidityCalldata + "]");
  return { proof, publicSignals, solidityCalldata };
}

export async function eSign(input: {
  hash: string;
  senderEmail: string;
  senderAccountCode: string;
}) {
  const publicInputs = {
    userOpHashIn: input.hash,
    emailCommitmentIn: input.senderAccountCode,
    pubkeyHashIn: input.pubkeyHashIn,
  };

  const { solidityCalldata } = await mockProver(publicInputs);

  const signature = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[3]"],
    solidityCalldata as any
  );

  return signature;
}

