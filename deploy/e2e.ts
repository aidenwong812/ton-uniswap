import {
    Address,
    TonClient,
    Cell,
    WalletContract,
    InternalMessage,
    CommonMessageInfo,
    StateInit,
    contractAddress,
    toNano,
    fromNano,
    beginCell,
} from "ton";
import { JettonMinter } from "../src/jetton-minter";
import BN from "bn.js";
import fs from "fs";

import axios from "axios";
import axiosThrottle from "axios-request-throttle";

import {
    hexToBn,
    initDeployKey,
    initWallet,
    printAddresses,
    printBalances,
    printDeployerBalances,
    sendTransaction,
    sleep,
    waitForContractToBeDeployed,
} from "../utils/deploy-utils";
import { JettonWallet } from "../src/jetton-wallet";
import { AmmMinterRPC } from "../src/amm-minter";
import { OPS } from "../src/ops";
import { AmmLpWallet } from "../src/amm-wallet";
import { compileFuncToB64 } from "../utils/funcToB64";

//axiosThrottle.use(axios, { requestsPerSecond: 0.5 }); // required since toncenter jsonRPC limits to 1 req/sec without API key
const client = new TonClient({
    endpoint: "https://sandbox.tonhubapi.com/jsonRPC",
    // endpoint: "https://scalable-api.tonwhales.com/jsonRPC",
    // endpoint: "https://toncenter.com/api/v2/jsonRPC",
});

enum GAS_FEES {
    ADD_LIQUIDITY = 0.2,
    REMOVE_LIQUIDITY = 0.25,
    SWAP_FEE = 0.04,
    SWAP_TON_FEE = 0.08,
    SWAP_FORWARD_TON = 0.04,
    MINT = 0.2,
}

const metadataURI = "https://api.jsonbin.io/b/eloelo1"; // Salt for ammMinter contract

const TON_LIQUIDITY = 4;
const TOKEN_LIQUIDITY = toNano(100);
const TOKEN_TO_SWAP = toNano(25);
const TON_TO_SWAP = toNano(1);
const MINT_SIZE = toNano(100);
const JETTON_URI = "http://tonswap.co/token/usdc31.json"; // Salt for USDC contract

const BLOCK_TIME = 10000;

async function deployUSDCMinter(
    client: TonClient,
    walletContract: WalletContract,
    owner: Address,
    privateKey: Buffer,
    jettonUri: string,
    workchain = 0
) {
    const { codeCell, initDataCell } = await JettonMinter.createDeployData(new BN(20000), owner, jettonUri);

    const newContractAddress = await contractAddress({
        workchain,
        initialData: initDataCell,
        initialCode: codeCell[0],
    });

    if (await client.isContractDeployed(newContractAddress)) {
        console.log(`contract: ${newContractAddress.toFriendly()} already Deployed`);
        return {
            address: newContractAddress,
        };
    }

    const seqno = await walletContract.getSeqNo();
    const transfer = await walletContract.createTransfer({
        secretKey: privateKey,
        seqno: seqno,
        sendMode: 1 + 2,
        order: new InternalMessage({
            to: newContractAddress,
            value: toNano(0.25),
            bounce: false,
            body: new CommonMessageInfo({
                stateInit: new StateInit({ data: initDataCell, code: codeCell[0] }),
                body: null,
            }),
        }),
    });

    await client.sendExternalMessage(walletContract, transfer);
    await waitForContractToBeDeployed(client, newContractAddress);
    console.log(`- Deploy transaction sent successfully to -> ${newContractAddress.toFriendly()} [seqno:${seqno}]`);
    await sleep(BLOCK_TIME);
    return {
        address: newContractAddress,
    };
}

async function deployMinter(client: TonClient, deployWallet: WalletContract, privateKey: Buffer) {
    const usdcMinter = await deployUSDCMinter(client, deployWallet, deployWallet.address, privateKey, JETTON_URI);
    const data = await client.callGetMethod(usdcMinter.address, "get_jetton_data", []);
    console.log(`usdcMinter totalSupply: ${fromNano(data.stack[0][1]).toString()}`);
    saveAddress("USDC-Minter", usdcMinter.address);
    return usdcMinter;
}

async function deployAmmMinter(client: TonClient, walletContract: WalletContract, privateKey: Buffer, workchain = 0) {
    const ammMinterRPC = new AmmMinterRPC({ rpcClient: client });
    const { codeCell, initDataCell } = await ammMinterRPC.buildDataCell(metadataURI, walletContract.address);

    const newContractAddress = await contractAddress({
        workchain,
        initialData: initDataCell,
        initialCode: codeCell[0],
    });

    saveAddress("AMM-Minter", newContractAddress);
    console.log(` - Deploy AmmMinter the contract on-chain.. [${newContractAddress.toFriendly()}]`);

    if (await client.isContractDeployed(newContractAddress)) {
        console.log(`${newContractAddress.toFriendly()} already Deployed`);
        return new AmmMinterRPC({
            address: newContractAddress,
            rpcClient: client,
        });
    }
    const seqno = await walletContract.getSeqNo();

    const transfer = await walletContract.createTransfer({
        secretKey: privateKey,
        seqno: seqno,
        sendMode: 1 + 2,
        order: new InternalMessage({
            to: newContractAddress,
            value: toNano(0.15),
            bounce: false,
            body: new CommonMessageInfo({
                stateInit: new StateInit({ data: initDataCell, code: codeCell[0] }),
                body: null,
            }),
        }),
    });

    await client.sendExternalMessage(walletContract, transfer);
    await waitForContractToBeDeployed(client, newContractAddress);
    console.log(`- Deploy transaction sent successfully to -> ${newContractAddress.toFriendly()}`);

    // new contracts takes time
    await sleep(BLOCK_TIME);

    ammMinterRPC.setAddress(newContractAddress);
    return ammMinterRPC;
}

export const addressToName: { [key: string]: string } = {};

function saveAddress(name: string, addr: Address) {
    addressToName[addr.toFriendly()] = name;
}

async function mintUSDC(usdcMinter: Address, deployWallet: WalletContract, privateKey: Buffer) {
    console.log(`
🎬 minting deployer some usdc's , 100$
`);
    await sendTransaction(
        client,
        deployWallet,
        usdcMinter,
        toNano(GAS_FEES.MINT),
        privateKey,
        JettonMinter.Mint(deployWallet.address, toNano(MINT_SIZE).add(toNano(TOKEN_TO_SWAP)))
    );
}

async function addLiquidity(ammMinter: AmmMinterRPC, deployWallet: WalletContract, deployerUSDCAddress: Address, privateKey: Buffer) {
    console.log(`
🎬 sending Add Liquidity message | ${TON_LIQUIDITY} 💎 : ${fromNano(TOKEN_LIQUIDITY)}💲
`);
    const addLiquidityMessage = JettonWallet.TransferOverloaded(
        ammMinter.address,
        TOKEN_LIQUIDITY, // jetton-amount
        ammMinter.address,
        toNano(TON_LIQUIDITY + GAS_FEES.ADD_LIQUIDITY / 2),
        OPS.ADD_LIQUIDITY,
        new BN(5), // Slippage
        toNano(TON_LIQUIDITY)
    );

    await sendTransaction(
        client,
        deployWallet,
        deployerUSDCAddress as Address,
        toNano(TON_LIQUIDITY + GAS_FEES.ADD_LIQUIDITY),
        privateKey,
        addLiquidityMessage
    );

    printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);
}

async function swapUsdcToTon(
    ammMinter: AmmMinterRPC,
    deployWallet: WalletContract,
    deployerUSDCAddress: Address,
    privateKey: Buffer,
    tokenToSell: BN
) {
    const ammData2 = await ammMinter.getJettonData();
    const minTonToReceive = await (
        await ammMinter.getAmountOut(tokenToSell, hexToBn(ammData2.tokenReserves), hexToBn(ammData2.tonReserves))
    ).minAmountOut;

    console.log(
        `\n🎬  Swap ${fromNano(new BN(tokenToSell.toString())).toString()}$ USDC to 💎Ton (expecting for ${fromNano(
            minTonToReceive.toString()
        )} 💎Ton)`
    );
    const swapTokenMessage = JettonWallet.TransferOverloaded(
        ammMinter.address,
        new BN(tokenToSell.toString()),
        deployWallet.address, // i should get the change
        toNano(GAS_FEES.SWAP_FORWARD_TON),
        OPS.SWAP_TOKEN,
        new BN(minTonToReceive.toString()) // Min Amount out (TON)
    );
    await sendTransaction(
        client,
        deployWallet,
        deployerUSDCAddress as Address,
        toNano(GAS_FEES.SWAP_FORWARD_TON + GAS_FEES.SWAP_FEE),
        privateKey,
        swapTokenMessage
    );

    //await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);
}

async function swapTonToUsdc(
    ammMinter: AmmMinterRPC,
    deployWallet: WalletContract,
    deployerUSDCAddress: Address,
    privateKey: Buffer,
    tokenToReceive: BN
) {
    const ammData = await ammMinter.getJettonData();

    const tonToSwap = await ammMinter.getAmountIn(tokenToReceive, hexToBn(ammData.tonReserves), hexToBn(ammData.tokenReserves));

    console.log(`
🎬  Swap ${fromNano(tonToSwap.amountIn.toString())}💎 to  $ (expecting for ${fromNano(tokenToReceive.toString())} $ )
`);
    const tonToSend = new BN(tonToSwap.amountIn.toString());
    const swapTonMessage = ammMinter.swapTon(tonToSend, tokenToReceive);
    await sendTransaction(
        client,
        deployWallet,
        ammMinter.address,
        tonToSend.add(toNano(GAS_FEES.SWAP_TON_FEE)),
        privateKey,
        swapTonMessage
    );

    await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);
}

async function removeLiquidity(
    ammMinter: AmmMinterRPC,
    deployWallet: WalletContract,
    deployerUSDCAddress: Address,
    privateKey: Buffer,
    sendMode = 3
) {
    await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);

    const lpAddress = (await ammMinter.getWalletAddress(deployWallet.address)) as Address;
    const lpData = await AmmLpWallet.GetWalletData(client, lpAddress);
    saveAddress("LP-Wallet", lpAddress);

    console.log(`
🎬  Remove Liquidity of ${fromNano(lpData.balance.toString())} LP's
`);

    const removeLiqMessage = AmmLpWallet.RemoveLiquidityMessage(new BN(lpData.balance.toString()), deployWallet.address);

    let messageIsBounceable = true;
    await sendTransaction(
        client,
        deployWallet,
        lpAddress,
        toNano(GAS_FEES.REMOVE_LIQUIDITY),
        privateKey,
        removeLiqMessage,
        messageIsBounceable,
        sendMode
    );

    sleep(BLOCK_TIME);
    await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);
}

async function codeUpgrade(ammMinter: AmmMinterRPC, deployWallet: WalletContract, deployerUSDCAddress: Address, privateKey: Buffer) {
    const ammMinterCodeB64: string = compileFuncToB64(["contracts/amm-minter-upgrade.fc"]);
    let codeCell = Cell.fromBoc(ammMinterCodeB64);
    const upgradeMessage = beginCell().storeUint(26, 32).storeUint(1, 64).storeRef(codeCell[0]).endCell();
    await sendTransaction(client, deployWallet, ammMinter.address, toNano(GAS_FEES.SWAP_FEE), privateKey, upgradeMessage);
    let age = await client.callGetMethod(ammMinter.address, "how_old", []);
    console.log(age);
}

async function main() {
    if (fs.existsSync("./build/tmp.fif")) {
        fs.rmSync("./build/tmp.fif");
    }

    const walletKey = await initDeployKey();
    let { wallet: deployWallet, walletBalance } = await initWallet(client, walletKey.publicKey);
    saveAddress("Deployer", deployWallet.address);

    const usdcMinter = await deployMinter(client, deployWallet, walletKey.secretKey);
    // await sleep(BLOCK_TIME);
    // await mintUSDC(usdcMinter.address, deployWallet, walletKey.secretKey);

    const deployerUSDCAddress = (await JettonMinter.GetWalletAddress(client, usdcMinter.address, deployWallet.address)) as Address;
    saveAddress("DeployerUSDC", deployerUSDCAddress);
    printDeployerBalances(client, deployWallet.address, deployerUSDCAddress);

    const ammMinter = await deployAmmMinter(client, deployWallet, walletKey.secretKey);

    await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);

    // // ======== add-liquidity
   await addLiquidity(ammMinter, deployWallet, deployerUSDCAddress as Address, walletKey.secretKey);
   await sleep(BLOCK_TIME * 2);

    await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);

    const swapCount = 8;
    console.log(`Swapping ${swapCount} times both ways`);

    for (let i = 0; i < swapCount; i++) {
        // // ======== Swap Ton -> USDC
        await swapTonToUsdc(ammMinter, deployWallet, deployerUSDCAddress as Address, walletKey.secretKey, TOKEN_TO_SWAP);
        await sleep(BLOCK_TIME * 2);
        await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);

        //  ======== Swap Usdc -> TON

        await swapUsdcToTon(ammMinter, deployWallet, deployerUSDCAddress as Address, walletKey.secretKey, TOKEN_TO_SWAP);
        await sleep(BLOCK_TIME * 2);
        await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);
    }

    await sleep(BLOCK_TIME);

    await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);

    // // ======= Remove Liquidity

    await removeLiquidity(ammMinter, deployWallet, deployerUSDCAddress as Address, walletKey.secretKey, 64);
    await sleep(BLOCK_TIME);

    //    await codeUpgrade(ammMinter, deployWallet, deployerUSDCAddress as Address, walletKey.secretKey);

    const currentBalance = await client.getBalance(deployWallet.address);
    console.log(`Deployer spent about ${fromNano(currentBalance.sub(walletBalance))} 💎`);

    await printBalances(client, ammMinter, deployWallet.address, deployerUSDCAddress);
    printAddresses(addressToName);
}

(async () => {
    await main();
})();
