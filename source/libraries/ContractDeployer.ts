import { hash } from "crypto-promise";
import { exists, readFile, writeFile } from "async-file";
import { exec } from "child_process";
import { encodeParams } from "ethjs-abi";
import { TransactionReceipt } from "ethjs-shared";
import { stringTo32ByteHex, resolveAll } from "./HelperFunctions";
import { CompilerOutput } from "solc";
import { Abi, AbiFunction } from "ethereum";
import { DeployerConfiguration } from "./DeployerConfiguration";
import { Connector } from "./Connector";
import {
  AugurLite,
  ContractFactory,
  Controller,
  Controlled,
  Universe,
  TimeControlled
} from "./ContractInterfaces";
import { NetworkConfiguration } from "./NetworkConfiguration";
import { AccountManager } from "./AccountManager";
import { Contracts, Contract } from "./Contracts";

export class ContractDeployer {
  private readonly accountManager: AccountManager;
  private readonly configuration: DeployerConfiguration;
  private readonly connector: Connector;
  private readonly contracts: Contracts;
  public controller: Controller;
  public universe: Universe;

  public static deployToNetwork = async (
    networkConfiguration: NetworkConfiguration,
    deployerConfiguration: DeployerConfiguration
  ) => {
    const connector = new Connector(networkConfiguration);
    const accountManager = new AccountManager(
      connector,
      networkConfiguration.privateKey
    );

    const compilerOutput = JSON.parse(
      await readFile(deployerConfiguration.contractInputPath, "utf8")
    );
    const contractDeployer = new ContractDeployer(
      deployerConfiguration,
      connector,
      accountManager,
      compilerOutput
    );

    console.log(`\n\n-----------------
Deploying to: ${networkConfiguration.networkName}
    compiled contracts: ${deployerConfiguration.contractInputPath}
    contract address: ${deployerConfiguration.contractAddressesOutputPath}
    upload blocks #s: ${deployerConfiguration.uploadBlockNumbersOutputPath}
`);
    await contractDeployer.deploy();
  };

  public constructor(
    configuration: DeployerConfiguration,
    connector: Connector,
    accountManager: AccountManager,
    compilerOutput: CompilerOutput
  ) {
    this.configuration = configuration;
    this.connector = connector;
    this.accountManager = accountManager;
    this.contracts = new Contracts(compilerOutput);
  }

  public async getBlockNumber(): Promise<number> {
    return this.connector.ethjsQuery
      .getBlockByNumber("latest", false)
      .then(block => block.number.toNumber());
  }

  public async deploy(): Promise<void> {
    const blockNumber = await this.getBlockNumber();

    this.controller = await this.uploadController();
    await this.uploadAugurLite();
    await this.uploadAllContracts();

    await this.initializeAllContracts();
    await this.whitelistTradingContracts();

    if (!this.configuration.useNormalTime) {
      await this.resetTimeControlled();
    }

    if (this.configuration.createGenesisUniverse) {
      this.universe = await this.createGenesisUniverse();
    }

    await this.generateUploadBlockNumberFile(blockNumber);
    await this.generateAddressMappingFile();
  }

  public getContract = (contractName: string): Controlled => {
    if (!this.contracts.has(contractName))
      throw new Error(`Contract named ${contractName} does not exist.`);
    const contract = this.contracts.get(contractName);
    if (contract.address === undefined)
      throw new Error(
        `Contract name ${contractName} has not yet been uploaded.`
      );
    const controlled = ContractFactory(
      this.connector,
      this.accountManager,
      contract.address,
      this.connector.gasPrice
    );
    return controlled;
  };

  private static async getGitCommit(): Promise<string> {
    // If we couldn't get the hash from a git repo, try to get it from NPM
    return await new Promise<string>((resolve, reject) => {
      exec("npm show . gitHead", (error, stdout, stderr) => {
        if (error) {
          console.log(stderr);
          return reject(error);
        }
        resolve(`0x${stdout.trim()}`);
      });
    });
  }

  private static async getBytecodeSha(bytecode: Buffer): Promise<string> {
    const digest = await hash("sha256")(bytecode);
    return `0x${digest.toString("hex")}`;
  }

  private static getEncodedConstructData(
    abi: Abi,
    bytecode: Buffer,
    constructorArgs: Array<string>
  ): Buffer {
    if (constructorArgs.length === 0) {
      return bytecode;
    }
    const constructorSignature = <AbiFunction | undefined>(
      abi.find(signature => signature.type === "constructor")
    );
    if (typeof constructorSignature === "undefined")
      throw new Error(`ABI did not contain a constructor.`);
    const constructorInputTypes = constructorSignature.inputs.map(x => x.type);
    const encodedConstructorParameters = Buffer.from(
      encodeParams(constructorInputTypes, constructorArgs).substring(2),
      "hex"
    );
    return Buffer.concat([bytecode, encodedConstructorParameters]);
  }

  private async uploadController(): Promise<Controller> {
    console.log("Uploading controller...");
    const address =
      this.configuration.controllerAddress !== undefined
        ? this.configuration.controllerAddress
        : await this.construct(
            this.contracts.get("Controller"),
            [],
            `Uploading Controller.sol`
          );
    const controller = new Controller(
      this.connector,
      this.accountManager,
      address,
      this.connector.gasPrice
    );
    const ownerAddress = await controller.owner_();
    if (
      ownerAddress.toLowerCase() !==
      this.accountManager.defaultAddress.toLowerCase()
    ) {
      throw new Error("Controller owner does not equal from address");
    }
    console.log(`Controller address: ${controller.address}`);
    return controller;
  }

  private async uploadAugurLite(): Promise<void> {
    // We have to upload and initialize AugurLite first so it can log the registration and whitelisting of other contracts
    const contract = await this.contracts.get("AugurLite");
    const address = await this.construct(
      contract,
      [],
      `Uploading ${contract.contractName}`
    );
    const commitHash = await ContractDeployer.getGitCommit();
    const bytecodeHash = await ContractDeployer.getBytecodeSha(
      contract.bytecode
    );
    const augurLite = new AugurLite(
      this.connector,
      this.accountManager,
      address,
      this.connector.gasPrice
    );
    contract.address = address;

    console.log(`AugurLite address: ${address}`);
    console.log(`Setting controller...`);
    await augurLite.setController(this.controller.address);
    console.log(`Registering the AugurLite contract with the controller...`);
    await this.controller.registerContract(
      stringTo32ByteHex("AugurLite"),
      address,
      commitHash,
      bytecodeHash
    );
  }

  private async uploadAllContracts(): Promise<void> {
    console.log("Uploading contracts...");
    const promises: Array<Promise<any>> = [];
    for (let contract of this.contracts) {
      promises.push(this.upload(contract));
    }
    await resolveAll(promises);
  }

  private async upload(contract: Contract): Promise<void> {
    const contractsToDelegate: { [key: string]: boolean } = {
      TestNetDenominationToken: true
    };

    const contractName = contract.contractName;
    if (contractName === "Controller") return;
    if (contractName === "Delegator") return;
    if (contractName === "TimeControlled") return;
    if (
      contractName === "TestNetDenominationToken" &&
      this.configuration.isProduction
    )
      return;
    if (contractName === "AugurLite") return;
    if (contractName === "Time")
      contract = this.configuration.useNormalTime
        ? contract
        : this.contracts.get("TimeControlled");
    if (
      contractName !== "Map" &&
      contract.relativeFilePath.startsWith("libraries/")
    )
      return;
    // Check to see if we have already uploded this version of the contract
    if (
      typeof this.configuration.controllerAddress !== "undefined" &&
      (await this.shouldSkipUploadingContract(
        contract,
        contractsToDelegate[contractName]
      ))
    ) {
      console.log(`Using existing contract for ${contractName}`);
      contract.address = await this.getExistingContractAddress(contractName);
    } else {
      console.log(`Uploading new version of contract for ${contractName}`);
      contract.address = contractsToDelegate[contractName]
        ? await this.uploadAndAddDelegatedToController(contract)
        : await this.uploadAndAddToController(contract, contractName);
    }
  }

  private async shouldSkipUploadingContract(
    contract: Contract,
    isDelegated: boolean
  ): Promise<boolean> {
    const bytecodeHash = await ContractDeployer.getBytecodeSha(
      contract.bytecode
    );
    const key = stringTo32ByteHex(
      isDelegated ? `${contract.contractName}Target` : contract.contractName
    );
    const contractDetails = await this.controller.getContractDetails_(key);
    const previouslyUploadedBytecodeHash = contractDetails[2];
    return bytecodeHash === previouslyUploadedBytecodeHash;
  }

  private async getExistingContractAddress(
    contractName: string
  ): Promise<string> {
    const key = stringTo32ByteHex(contractName);
    const contractDetails = await this.controller.getContractDetails_(key);
    return contractDetails[0];
  }

  private async uploadAndAddDelegatedToController(
    contract: Contract
  ): Promise<string> {
    const delegationTargetName = `${contract.contractName}Target`;
    const delegatorConstructorArgs = [
      this.controller.address,
      stringTo32ByteHex(delegationTargetName)
    ];
    await this.uploadAndAddToController(contract, delegationTargetName);
    return await this.uploadAndAddToController(
      this.contracts.get("Delegator"),
      contract.contractName,
      delegatorConstructorArgs
    );
  }

  private async uploadAndAddToController(
    contract: Contract,
    registrationContractName: string = contract.contractName,
    constructorArgs: Array<any> = []
  ): Promise<string> {
    const address = await this.construct(
      contract,
      constructorArgs,
      `Uploading ${contract.contractName}`
    );
    const commitHash = await ContractDeployer.getGitCommit();
    const bytecodeHash = await ContractDeployer.getBytecodeSha(
      contract.bytecode
    );
    await this.controller.registerContract(
      stringTo32ByteHex(registrationContractName),
      address,
      commitHash,
      bytecodeHash
    );
    return address;
  }

  private async construct(
    contract: Contract,
    constructorArgs: Array<string>,
    failureDetails: string
  ): Promise<string> {
    const data = `0x${ContractDeployer.getEncodedConstructData(
      contract.abi,
      contract.bytecode,
      constructorArgs
    ).toString("hex")}`;
    const gasEstimate = await this.connector.ethjsQuery.estimateGas({
      from: this.accountManager.defaultAddress,
      data: data
    });
    const nonce = await this.accountManager.nonces.get(
      this.accountManager.defaultAddress
    );
    const signedTransaction = await this.accountManager.signTransaction({
      gas: gasEstimate,
      gasPrice: this.connector.gasPrice,
      data: data
    });
    console.log(
      `Upload contract: ${
        contract.contractName
      } nonce: ${nonce}, gas: ${gasEstimate}, gasPrice: ${
        this.connector.gasPrice
      }`
    );
    const transactionHash = await this.connector.ethjsQuery.sendRawTransaction(
      signedTransaction
    );
    const receipt = await this.connector.waitForTransactionReceipt(
      transactionHash,
      failureDetails
    );
    console.log(
      `Uploaded contract: ${contract.contractName}: \"${
        receipt.contractAddress
      }\"`
    );
    return receipt.contractAddress;
  }

  private async whitelistTradingContracts(): Promise<void> {
    console.log("Whitelisting contracts...");
    const promises: Array<Promise<any>> = [];
    const contractsToWhitelist = ["ClaimTradingProceeds", "CompleteSets"];
    for (let contract of this.contracts) {
      if (!contractsToWhitelist.includes(contract.contractName)) continue;
      if (contract.address === undefined)
        throw new Error(
          `Attempted to whitelist ${
            contract.contractName
          } but it has not yet been uploaded.`
        );
      // Skip if already whitelisted (happens if this contract was previously uploaded)
      if (await this.controller.whitelist_(contract.address)) {
        console.log(`Skipping already whitelisted ${contract.contractName}.`);
        continue;
      } else {
        console.log(`Whitelisting ${contract.contractName}`);
        promises.push(this.whitelistContract(contract.address));
      }
    }
    await resolveAll(promises);
  }

  private async whitelistContract(contractAddress: string): Promise<void> {
    return await this.controller.addToWhitelist(contractAddress, {
      sender: this.accountManager.defaultAddress
    });
  }

  private async initializeAllContracts(): Promise<void> {
    console.log("Initializing contracts...");
    const contractsToInitialize = [
      "CompleteSets",
      "Time",
      "ClaimTradingProceeds"
    ];
    const promises: Array<Promise<any>> = [];
    for (let contractName of contractsToInitialize) {
      promises.push(this.initializeContract(contractName));
    }
    resolveAll(promises);
  }

  private async initializeContract(
    contractName: string
  ): Promise<TransactionReceipt | void> {
    // Check if contract already initialized (happens if this contract was previously uploaded)
    if (contractName === "Time")
      contractName = this.configuration.useNormalTime
        ? contractName
        : "TimeControlled";
    if (
      (await this.getContract(contractName).getController_()) ===
      this.controller.address
    ) {
      console.log(`Skipping already initialized ${contractName}.`);
      return;
    }
    console.log(`Initializing ${contractName}`);
    await this.getContract(contractName).setController(this.controller.address);
  }

  private async resetTimeControlled(): Promise<void> {
    console.log("Resetting Timestamp for false time...");
    const time = new TimeControlled(
      this.connector,
      this.accountManager,
      this.getContract("TimeControlled").address,
      this.connector.gasPrice
    );
    const currentTimestamp = await time.getTimestamp_();
    return time.setTimestamp(currentTimestamp);
  }

  private async createGenesisUniverse(): Promise<Universe> {
    const augurLite = new AugurLite(
      this.connector,
      this.accountManager,
      this.getContract("AugurLite").address,
      this.connector.gasPrice
    );
    const denominationToken =
      this.configuration.genesisDenominationTokenAddress ||
      this.getContract("TestNetDenominationToken").address;
    console.log(
      `Creating genesis universe, with denomination token ${denominationToken}...`
    );
    const universeAddress = await augurLite.createUniverse_(denominationToken);
    if (!universeAddress || universeAddress == "0x") {
      throw new Error("Unable to create genesis universe. eth_call failed");
    }
    await augurLite.createUniverse(denominationToken);
    const universe = new Universe(
      this.connector,
      this.accountManager,
      universeAddress,
      this.connector.gasPrice
    );
    console.log(`Genesis universe address: ${universe.address}`);
    if ((await universe.getTypeName_()) !== stringTo32ByteHex("Universe")) {
      throw new Error(
        "Unable to create genesis universe. Get type name failed"
      );
    }

    return universe;
  }

  private async generateAddressMapping(): Promise<string> {
    type ContractAddressMapping = { [name: string]: string };
    type NetworkAddressMapping = {
      [networkId: string]: ContractAddressMapping;
    };

    const tradingContracts = [
      "ClaimTradingProceeds",
      "CompleteSets",
      "ShareToken"
    ];

    const mapping: ContractAddressMapping = {};
    mapping["Controller"] = this.controller.address;
    if (this.universe) mapping["Universe"] = this.universe.address;
    if (this.contracts.get("AugurLite").address === undefined)
      throw new Error(`AugurLite not uploaded.`);
    mapping["AugurLite"] = this.contracts.get("AugurLite").address!;
    for (let contract of this.contracts) {
      if (!tradingContracts.includes(contract.contractName)) continue;
      if (/^I[A-Z].*/.test(contract.contractName)) continue;
      if (contract.address === undefined)
        throw new Error(`${contract.contractName} not uploaded.`);
      mapping[contract.contractName] = contract.address;
    }

    const networkId = await this.connector.ethjsQuery.net_version();
    let addressMapping: NetworkAddressMapping = {};
    if (await exists(this.configuration.contractAddressesOutputPath)) {
      let existingAddressFileData: string = await readFile(
        this.configuration.contractAddressesOutputPath,
        "utf8"
      );
      addressMapping = JSON.parse(existingAddressFileData);
    }
    addressMapping[networkId] = mapping;
    return JSON.stringify(addressMapping, null, " ");
  }

  private async generateAddressMappingFile(): Promise<void> {
    const addressMappingJson = await this.generateAddressMapping();
    await writeFile(
      this.configuration.contractAddressesOutputPath,
      addressMappingJson,
      "utf8"
    );
  }

  private async generateUploadBlockNumberMapping(
    blockNumber: number
  ): Promise<string> {
    type UploadBlockNumberMapping = { [networkId: string]: number };

    const networkId = await this.connector.ethjsQuery.net_version();
    let blockNumberMapping: UploadBlockNumberMapping = {};
    if (await exists(this.configuration.uploadBlockNumbersOutputPath)) {
      let existingBlockNumberData: string = await readFile(
        this.configuration.uploadBlockNumbersOutputPath,
        "utf8"
      );
      blockNumberMapping = JSON.parse(existingBlockNumberData);
    }
    blockNumberMapping[networkId] = blockNumber;
    return JSON.stringify(blockNumberMapping, null, "  ");
  }

  private async generateUploadBlockNumberFile(
    blockNumber: number
  ): Promise<void> {
    const blockNumberMapping = await this.generateUploadBlockNumberMapping(
      blockNumber
    );
    await writeFile(
      this.configuration.uploadBlockNumbersOutputPath,
      blockNumberMapping,
      "utf8"
    );
  }
}
