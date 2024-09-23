import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import * as dotenv from "dotenv";

dotenv.config();

const {NODE_URL} = process.env;

const config: HardhatUserConfig = {
  solidity: "0.8.27",
  networks: {
    dev: {
      chainId: 31337,
      url: NODE_URL,
    },
  },
};

export default config;
