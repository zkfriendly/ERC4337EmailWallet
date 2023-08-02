import { createContext, useContext, useEffect, useState } from 'react';
import WaxInPage, { Contracts, EthereumApi } from '../src';
import TypedEmitter from './helpers/TypedEmitter';
import runAsync from './helpers/runAsync';

export default class DemoContext {
  ethereum: EthereumApi;
  address?: string;
  contracts?: Contracts;
  #contractsPromise?: Promise<Contracts>;

  events = new TypedEmitter<{
    addressChanged(newAddress?: string): void;
    contractsChanged(newContracts?: Contracts): void;
  }>();

  constructor(public waxInPage: WaxInPage) {
    this.ethereum = waxInPage.ethereum;

    runAsync(async () => {
      const accounts = await this.ethereum.request({
        method: 'eth_accounts',
      });

      if (accounts.length > 0) {
        this.setAddress(accounts[0]);
      }
    });
  }

  private static context = createContext<DemoContext>({} as DemoContext);

  static Provider = DemoContext.context.Provider;

  static use = () => useContext(DemoContext.context);

  async clear() {
    await this.waxInPage.storage.clear();
    this.setAddress(undefined);
  }

  setAddress(newAddress?: string) {
    this.address = newAddress;
    this.events.emit('addressChanged', newAddress);
  }

  setContracts(newContracts?: Contracts) {
    this.contracts = newContracts;
    this.events.emit('contractsChanged', newContracts);
  }

  async requestAddress() {
    const response = await this.ethereum.request({
      method: 'eth_requestAccounts',
    });

    this.setAddress(response[0]);
  }

  useAddress = () => {
    const [address, setAddress] = useState(this.address);

    useEffect(() => {
      const listener = (newAddress: string) => {
        setAddress(newAddress);
      };

      this.events.on('addressChanged', listener);

      return () => {
        this.events.off('addressChanged', listener);
      };
    }, []);

    return address;
  };

  useContracts = () => {
    const [contracts, setContracts] = useState(this.contracts);

    useEffect(() => {
      const listener = (newContracts: Contracts) => {
        setContracts(newContracts);
      };

      this.events.on('contractsChanged', listener);

      if (!this.contracts) {
        void this.getContracts();
      }

      return () => {
        this.events.off('contractsChanged', listener);
      };
    }, []);

    return contracts;
  };

  async getContracts() {
    if (this.#contractsPromise) {
      return await this.#contractsPromise;
    }

    this.#contractsPromise = this.waxInPage.getContracts();

    try {
      const contracts = await this.#contractsPromise;
      this.setContracts(contracts);
      return contracts;
    } finally {
      this.#contractsPromise = undefined;
    }
  }
}
