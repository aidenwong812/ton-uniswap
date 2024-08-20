//@ts-ignore
import { SmartContract } from "ton-contract-executor";
import BN from "bn.js";
import { filterLogs, parseInternalMessageResponse } from "./utils";
import { AmmLpWallet } from "./amm-wallet";
import { Address, Cell, CellMessage, InternalMessage, Slice, CommonMessageInfo, TonClient, contractAddress, toNano, fromNano } from "ton";
import { sliceToAddress267, toUnixTime } from "./utils";
import { OPS } from "./ops";
import { compileFuncToB64 } from "../utils/funcToB64";
import { bytesToAddress } from "../utils/deploy-utils";
import { writeString } from "./utils";
import { OutAction } from "ton-contract-executor";
import { printChain, TvmBus, iTvmBusContract } from "ton-tvm-bus";

const myContractAddress = Address.parse("EQBZjEzfbSslRltL4z7ncz_tb-t1z5R98zAKUuWLO1QTINTA");

export class AmmMinterMessages {
    static swapTon(tonToSwap: BN, minAmountOut: BN): Cell {
        let cell = new Cell();
        cell.bits.writeUint(OPS.SWAP_TON, 32); // action
        cell.bits.writeUint(1, 64); // query-id
        cell.bits.writeCoins(tonToSwap); // swapping amount of tons
        cell.bits.writeCoins(minAmountOut); // minimum received
        return cell;
    }
    static compileCodeToCell() {
        const ammMinterCodeB64: string = compileFuncToB64(["contracts/amm-minter.fc"]);
        return Cell.fromBoc(ammMinterCodeB64);
    }

    static buildDataCell(content: string, admin: Address) {
        const contentCell = new Cell();
        writeString(contentCell, content);

        const dataCell = new Cell();
        dataCell.bits.writeCoins(0); // total-supply
        dataCell.bits.writeAddress(zeroAddress()); // token_wallet_address starts as null
        dataCell.bits.writeCoins(0); // ton-reserves
        dataCell.bits.writeCoins(0); // token-reserves
        dataCell.bits.writeAddress(admin);
        dataCell.refs.push(contentCell);
        dataCell.refs.push(AmmLpWallet.compileWallet()[0]);
        return {
            initDataCell: dataCell,
            codeCell: this.compileCodeToCell(),
        };
    }

    static getCodeUpgrade() {
        const ammMinterCodeB64: string = compileFuncToB64(["contracts/amm-minter-upgrade.fc"]);
        return Cell.fromBoc(ammMinterCodeB64);
    }
}

export class AmmMinterRPC {
    address = zeroAddress();
    client: TonClient;
    resolveReady = () => {};
    ready = new Promise(this.resolveReady);

    constructor(opts: { address?: Address; rpcClient: TonClient }) {
        this.client = opts.rpcClient;
        if (opts.address) {
            this.address = opts.address;
            this.resolveReady();
        }
    }

    setAddress(address: Address) {
        this.address = address;
        this.resolveReady();
    }

    async getWalletAddress(walletAddress: Address) {
        try {
            let cell = new Cell();
            cell.bits.writeAddress(walletAddress);
            let b64dataBuffer = (await cell.toBoc({ idx: false })).toString("base64");
            let res = await this.client.callGetMethod(this.address, "get_wallet_address", [["tvm.Slice", b64dataBuffer]]);
            return bytesToAddress(res.stack[0][1].bytes);
        } catch (e) {
            console.log("exception", e);
        }
    }

    async getAmountOut(amountIn: BN, reserveIn: BN, reserveOut: BN) {
        let res = await this.client.callGetMethod(this.address, "get_amount_out", [
            ["num", amountIn.toString()],
            ["num", reserveIn.toString()],
            ["num", reserveOut.toString()],
        ]);
        return {
            minAmountOut: BigInt(res.stack[0][1]),
        };
    }
    //int get_amount_in(int amountOut, int reserveIn, int reserveOut) method_id {
    async getAmountIn(amountOut: BN, reserveIn: BN, reserveOut: BN) {
        let res = await this.client.callGetMethod(this.address, "get_amount_in", [
            ["num", amountOut.toString()],
            ["num", reserveIn.toString()],
            ["num", reserveOut.toString()],
        ]);
        return {
            amountIn: BigInt(res.stack[0][1]),
        };
    }

    async getJettonData() {
        let res = await this.client.callGetMethod(this.address, "get_jetton_data", []);

        const totalSupply = res.stack[0][1] as string;
        const mintable = res.stack[1][1] as string;
        const jettonWalletAddressBytes = res.stack[2][1].bytes as string;
        const tonReserves = res.stack[3][1] as string;
        const tokenReserves = res.stack[4][1] as string;
        return {
            totalSupply,
            jettonWalletAddress: bytesToAddress(jettonWalletAddressBytes),
            mintable,
            tonReserves,
            tokenReserves,
        };
    }
}

export class AmmMinterTVM implements iTvmBusContract {
    contract?: SmartContract;
    ready?: Promise<SmartContract>;
    balance?: BN;
    address?: Address;

    constructor(contentUri: string, admin: Address, tvmBus?: TvmBus, balance = toNano(1)) {
        this.init(contentUri, admin, balance, tvmBus);
    }

    async init(contentUri: string, admin: Address, balance: BN, tvmBus?: TvmBus) {
        const data = AmmMinterMessages.buildDataCell(contentUri, admin);
        const code = AmmMinterMessages.compileCodeToCell();
        const address = contractAddress({
            workchain: 0,
            initialCode: code[0],
            initialData: data.initDataCell,
        });
        this.address = address;

        this.ready = SmartContract.fromCell(code[0], data.initDataCell, {
            getMethodsMutate: true,
            debug: true,
        });
        const contract = await this.ready;
        this.contract = contract;
        this.balance = balance;

        contract.setUnixTime(toUnixTime(Date.now()));
        contract.setC7Config({
            myself: address,
            balance: balance,
        });
        if (tvmBus) {
            tvmBus.registerContract(this);
        }
    }

    async getData() {
        if (!this.contract) {
            throw "contract is not initialized";
        }
        let res = await this.contract.invokeGetMethod("get_jetton_data", []);
        const totalSupply = res.result[0] as BN;
        const mintable = res.result[1] as BN;
        //@ts-ignore
        const tokenWalletAddress = sliceToAddress267(res.result[2] as BN).toFriendly();
        const tonReserves = res.result[3] as BN;
        const tokenReserves = res.result[4] as BN;
        //@ts-ignore
        //  const admin = sliceToAddress267(res.result[5] as BN).toFriendly();
        const content = res.result[2] as Cell;

        return {
            totalSupply,
            mintable,
            tokenWalletAddress,
            tonReserves,
            tokenReserves,
            content,
        };
    }

    async sendInternalMessage(message: InternalMessage) {
        if (!this.contract) {
            throw "contract is not initialized";
        }

        let nMessage = new InternalMessage({
            to: message.to,
            from: message.from,
            value: message.value, //ignore this.balance for now
            bounce: message.bounce,
            body: message.body,
        });

        let res = await this.contract.sendInternalMessage(nMessage);
        let parsedResponse = parseInternalMessageResponse(res);
        if (res.exit_code == 0) {
            // this.calculateBalance(message.value, parsedResponse.actions);
        }
        return parsedResponse;
    }

    async swapTonTVM(from: Address, tonToSwap: BN, minAmountOut: BN, valueOverride?: BN) {
        const gasFee = new BN(200000000);
        let messageBody = AmmMinterMessages.swapTon(tonToSwap, minAmountOut);

        if (valueOverride) {
            tonToSwap = valueOverride.add(gasFee);
        }
        return this.sendTvmMessage({ messageBody, from, value: tonToSwap.add(gasFee), to: myContractAddress, bounce: true });
    }

    // burn#595f07bc query_id:uint64 amount:(VarUInteger 16)
    //           response_destination:MsgAddress custom_payload:(Maybe ^Cell)
    //           = InternalMsgBody;
    async receiveBurn(subWalletOwner: Address, sourceWallet: Address, amount: BN) {
        let messageBody = new Cell();
        messageBody.bits.writeUint(OPS.Burn_notification, 32); // action
        messageBody.bits.writeUint(1, 64); // query-id
        messageBody.bits.writeCoins(amount); // jetton amount received
        messageBody.bits.writeAddress(sourceWallet);

        const removeLiquidityAmount = 300000;
        let customPayload = new Cell();
        customPayload.bits.writeUint(2, 32); // sub op for removing liquidty
        customPayload.bits.writeCoins(removeLiquidityAmount); // sub op for removing liquidty

        messageBody.refs.push(customPayload);

        return this.sendTvmMessage({ messageBody, from: subWalletOwner, value: new BN(10000), to: myContractAddress, bounce: true });
    }

    async getAmountOut(amountIn: BN, reserveIn: BN, reserveOut: BN) {
        if (!this.contract) {
            throw "contract is not initialized";
        }
        let res = await this.contract.invokeGetMethod("get_amount_out", [
            { type: "int", value: amountIn.toString() },
            { type: "int", value: reserveIn.toString() },
            { type: "int", value: reserveOut.toString() },
        ]);

        const minAmountOut = res.result[0] as BN;
        return {
            minAmountOut,
        };
    }

    async sendTvmMessage(opts: { messageBody: Cell; from: Address; to: Address; value: BN; bounce: boolean }) {
        if (!this.contract) {
            throw "contract is not initialized";
        }

        let res = await this.contract.sendInternalMessage(
            new InternalMessage({
                from: opts.from,
                to: myContractAddress,
                value: opts.value,
                bounce: false,
                body: new CommonMessageInfo({ body: new CellMessage(opts.messageBody) }),
            })
        );

        // let successResult = res as SuccessfulExecutionResult;
        // const actions = parseActionsList(successResult.action_list_cell);
        // if (res.exit_code == 0) {
        //     this.calculateBalance(opts.value, actions);
        // }

        return {
            ...res,
            logs: filterLogs(res.logs),
        };
    }

    // calculateBalance(inValue: BN, actions: OutAction[]) {
    //     this.balance = this.balance?.add(inValue);
    //     let outGoingTon = actions.map((action: OutAction) => {
    //         // @ts-ignore
    //         const sendMessageAction = action as SendMsgOutAction;
    //         return sendMessageAction.value?.coins;
    //     });
    //     let outGoingTonSum = new BN(0);
    //     outGoingTon.forEach((it: BN) => {
    //         if (it) {
    //             outGoingTonSum.add(it);
    //         }
    //     });

    //     //console.log({ outGoingTonSum: outGoingTonSum.toString(), balance: this.balance.toString() });
    //     this.balance = this.balance?.sub(outGoingTonSum);
    // }

    async getHowOld() {
        if (!this.contract) {
            throw "contract is not initialized";
        }
        let res = await this.contract.invokeGetMethod("how_old", []);
        return res;
    }
}

// Null Address EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c
function zeroAddress() {
    let cell = new Cell();
    cell.bits.writeUint(2, 2);
    cell.bits.writeUint(0, 1);
    cell.bits.writeUint(0, 8);
    cell.bits.writeUint(0x0000000000000000, 256);

    return cell.beginParse().readAddress() as Address;
}
