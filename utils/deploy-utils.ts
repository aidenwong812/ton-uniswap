import { mnemonicNew, mnemonicToWalletKey } from "ton-crypto";
import * as fs from "fs";
import { Address, Cell, CellMessage, CommonMessageInfo, fromNano, InternalMessage, TonClient, WalletContract, WalletV3R2Source } from "ton";
import { AmmMinterRPC } from "../src/amm-minter";
import { JettonWallet } from "../src/jetton-wallet";
import BN from "bn.js";
const BOC_MAX_LENGTH = 48;

export async function initDeployKey() {
    const deployConfigJson = `./build/deploy.config.json`;
    const deployerWalletType = "org.ton.wallets.v3.r2";
    let deployerMnemonic;
    if (!fs.existsSync(deployConfigJson)) {
        console.log(`\n* Config file '${deployConfigJson}' not found, creating a new wallet for deploy..`);
        deployerMnemonic = (await mnemonicNew(24)).join(" ");
        const deployWalletJsonContent = {
            created: new Date().toISOString(),
            deployerWalletType,
            deployerMnemonic,
        };
        fs.writeFileSync(deployConfigJson, JSON.stringify(deployWalletJsonContent, null, 2));
        console.log(` - Created new wallet in '${deployConfigJson}' - keep this file secret!`);
    } else {
        console.log(`\n* Config file '${deployConfigJson}' found and will be used for deployment!`);
        const deployConfigJsonContentRaw = fs.readFileSync(deployConfigJson, "utf-8");
        const deployConfigJsonContent = JSON.parse(deployConfigJsonContentRaw);
        if (!deployConfigJsonContent.deployerMnemonic) {
            console.log(` - ERROR: '${deployConfigJson}' does not have the key 'deployerMnemonic'`);
            process.exit(1);
        }
        deployerMnemonic = deployConfigJsonContent.deployerMnemonic;
    }
    return mnemonicToWalletKey(deployerMnemonic.split(" "));
}

export function bytesToAddress(bufferB64: string) {
    const buff = Buffer.from(bufferB64, "base64");
    let c2 = Cell.fromBoc(buff);
    return c2[0].beginParse().readAddress() as Address;
}

export function sleep(time: number) {
    return new Promise((resolve) => {
        console.log(`💤 ${time / 1000}s ...`);

        setTimeout(resolve, time);
    });
}
export async function printDeployerBalances(client: TonClient, deployer: Address, deployerUSDCAddress: Address) {
    const usdcData = await JettonWallet.GetData(client, deployerUSDCAddress);
    const ton = await client.getBalance(deployer);
    console.log(``);
    console.log(`⛏  Deployer Balance: ${fromNano(ton)}💎 | ${fromNano(usdcData.balance.toString())}$ USDC `);
    console.log(``);
}

export async function printBalances(client: TonClient, ammMinter: AmmMinterRPC, deployer: Address, deployerUSDCAddress?: Address) {
    try {
        const data = await ammMinter.getJettonData();
        const balance = await client.getBalance(ammMinter.address);
        console.log(`-----==== AmmMinter ====-----  `);
        console.log(`[${ammMinter.address.toFriendly()}]
        💎 balance      : ${fromNano(balance)} ${fromNano(balance.sub(hexToBn(data.tonReserves)))}
        💰 totalSupply  : ${hexToBn(data.totalSupply)} (${bnFmt(hexToBn(data.totalSupply))})
        💰 tonReserves  : ${hexToBn(data.tonReserves)} (${bnFmt(hexToBn(data.tonReserves))})
        💰 tokenReserves: ${hexToBn(data.tokenReserves)} (${bnFmt(hexToBn(data.tokenReserves))})
        📪 JettonWallet : ${data.jettonWalletAddress.toFriendly()}
        `);
        // await printDeployerBalances(client, deployer, deployerUSDCAddress);
        console.log(`-----==== ***** ====-----
        `);
    } catch (e) {}
}

export function hexToBn(num: string) {
    return new BN(BigInt(num).toString());
}

export function bnFmt(num: BN | BigInt) {
    let str = num.toString();
    return `${BigInt(str) / BigInt(1e9)}.${BigInt(str) % BigInt(1e9)} `;
}

export function hexFromNano(num: string) {
    const res = BigInt(num) / BigInt(100000000);
    return res.toString();
}

export function printAddresses(addressBook: { [key: string]: string }, network: "sandbox." | "test." | "" = "") {
    console.log(``); //br
    let lsSnippet = ``;
    for (var key in addressBook) {
        const address = key;
        console.log(`${addressBook[key]} : https://${network}tonwhales.com/explorer/address/${key}`);
        const ellipsisAddress = `${address.substring(0, 6)}...${address.substring(address.length - 7, address.length - 1)}`;
        lsSnippet += `localStorage["${key}"]="${addressBook[key]}";`;
        lsSnippet += `localStorage["${ellipsisAddress}"]="${addressBook[key]}";`;
    }
    console.log(``);
    console.log(lsSnippet);
    console.log(``);
}

export async function initWallet(client: TonClient, publicKey: Buffer, workchain = 0) {
    const wallet = await WalletContract.create(client, WalletV3R2Source.create({ publicKey: publicKey, workchain }));
    const walletBalance = await client.getBalance(wallet.address);
    if (parseFloat(fromNano(walletBalance)) < 1) {
        throw `Insufficient Deployer [${wallet.address.toFriendly()}] funds ${fromNano(walletBalance)}`;
    }
    console.log(
        `Init wallet ${wallet.address.toFriendly()} | 
balance: ${fromNano(await client.getBalance(wallet.address))} | seqno: ${await wallet.getSeqNo()}
`
    );

    return { wallet, walletBalance };
}

export async function waitForSeqno(walletContract: WalletContract, seqno: number) {
    const seqnoStepInterval = 3000;
    console.log(`⏳ waiting for seqno to update (${seqno})`);
    for (var attempt = 0; attempt < 10; attempt++) {
        await sleep(seqnoStepInterval);
        const seqnoAfter = await walletContract.getSeqNo();
        if (seqnoAfter > seqno) break;
    }
    console.log(`⌛️ seqno update after ${((attempt + 1) * seqnoStepInterval) / 1000}s`);
}

export async function waitForContractToBeDeployed(client: TonClient, deployedContract: Address) {
    const seqnoStepInterval = 2500;
    console.log(`⏳ waiting for contract to be deployed at [${deployedContract.toFriendly()}]`);
    for (var attempt = 0; attempt < 10; attempt++) {
        await sleep(seqnoStepInterval);
        if (await client.isContractDeployed(deployedContract)) {
            break;
        }
    }
    console.log(`⌛️ waited for contract deployment ${((attempt + 1) * seqnoStepInterval) / 1000}s`);
}

export async function sendTransaction(
    client: TonClient,
    walletContract: WalletContract,
    receivingContract: Address,
    value: BN,
    privateKey: Buffer,
    messageBody: Cell,
    bounce = false,
    sendMode = 3
) {
    const seqno = await walletContract.getSeqNo();
    const bocStr = await messageBody.toString();
    const boc = bocStr.substring(0, bocStr.length < BOC_MAX_LENGTH ? bocStr.length : BOC_MAX_LENGTH).toString();
    console.log(`🧱 send Transaction to ${receivingContract.toFriendly()} value:${fromNano(value)}💎 [boc:${boc}]`);

    const transfer = await walletContract.createTransfer({
        secretKey: privateKey,
        seqno: seqno,
        sendMode: sendMode,
        order: new InternalMessage({
            to: receivingContract,
            value: value,
            bounce,
            body: new CommonMessageInfo({
                body: new CellMessage(messageBody),
            }),
        }),
    });
    console.log(`🚀 sending transaction to contract [seqno:${seqno}]`);

    client.sendExternalMessage(walletContract, transfer);

    await waitForSeqno(walletContract, seqno);
}
