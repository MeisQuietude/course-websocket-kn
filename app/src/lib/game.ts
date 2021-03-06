import Field from "./field";
import { Namespace, Socket } from "socket.io";
import { Game as GameModel } from "../data";
import { InstanceType } from "typegoose";
import { GameSchema } from "../data/models/game";

enum IAM {
    PLAYER1 = "Player 1",
    PLAYER2 = "Player 2",
    SPECTATOR = "Spectator"
}

enum IAMValue {
    PLAYER1 = 1,
    PLAYER2 = 2,
    SPECTATOR = 0
}

class Client {
    public socket: Socket;
    public value = 0;

    constructor(socket: Socket) {
        this.socket = socket;
    }

    toString = (): string => this.socket.id;
}

class Game {
    private static Model = GameModel;
    private ModelRecord: InstanceType<GameSchema>;

    private name: string;
    private fieldSize: number;
    private winCombination: number;

    public whoami: string;

    private clients: Client[] = [];
    public player1: Client;
    public player2: Client;
    public spectators: Client[] = [];

    public field: Field;
    public lastTurn: number;

    constructor(name: string, fieldSize: number, winCombination: number) {
        this.name = name;
        this.fieldSize = fieldSize;
        this.winCombination = winCombination;

        this.field = new Field(this.fieldSize, this.winCombination); // TODO: should I create an empty field here?
    }

    public static init = async (id: string, roomClients: Namespace): Promise<Game> => {
        const gameRecord = await Game.Model.findById(id).exec();

        const { name, fieldSize, winCombination, cellTable, lastTurn, player1, player2, spectators } = gameRecord;

        const gameInstance = new Game(name, fieldSize, winCombination);
        gameInstance.field = new Field(fieldSize, winCombination, cellTable);
        gameInstance.lastTurn = lastTurn;

        if (player1) {
            gameInstance.player1 = new Client(roomClients.sockets[player1]);
        }
        if (player2) {
            gameInstance.player2 = new Client(roomClients.sockets[player2]);
        }
        if (spectators && spectators.length > 0) {
            gameInstance.spectators = spectators.map(spectator => new Client(roomClients.sockets[spectator]));
        }

        gameInstance.ModelRecord = gameRecord;

        return gameInstance;
    }

    public save = async (): Promise<void> => {
        const { name, fieldSize, winCombination, field, lastTurn } = this;

        if (!this.ModelRecord) {
            this.ModelRecord = await Game.Model.create({
                name,
                fieldSize,
                winCombination,
                cellTable: field.cellTable,
            });
        } else {
            await this.ModelRecord.updateOne({
                cellTable: field.cellTable,
                lastTurn,
            }).exec();
        }

        await this.ModelRecord.save();
    }

    public update = async (): Promise<void> => {
        this.ModelRecord = await Game.Model.findById(this.ModelRecord.id);
        this.field.cellTable = this.ModelRecord.cellTable;
        this.lastTurn = this.ModelRecord.lastTurn;
        // this.player1 = this.clients.find(client => client.socket.id === this.ModelRecord.player1);
        // this.player2 = this.clients.find(client => client.socket.id === this.ModelRecord.player2);
    }

    public actionTurn = async (client: Socket, cellIndex: number): Promise<number> => {
        await this.update();

        const player = this._onlyPlayerAccess(client);
        if (
            // !this.player1 ||
            // !this.player2 ||
            !player ||
            this.lastTurn === player.value) {

            return null;
        }

        const { row, col } = this.translateFlatToIndex(cellIndex);

        if (this.field.getCellValue(row, col) == 0) {
            this.field.setCellValue(row, col, player.value);
            this.lastTurn = player.value;
            await this.save();
            return player.value;
        }
        return null;
    }

    public isWin = (flatIndex: number): number => {
        const { row, col } = this.translateFlatToIndex(flatIndex);
        const isWin_ = this.field.isWin(row, col);
        if (isWin_ && isWin_.player !== undefined) {
            return isWin_.player;
        }
    };

    public addClient = async (client: Socket): Promise<void> => {
        const client_ = new Client(client);
        this.clients.push(client_);
        if (!this.player1) {
            await this._setPlayer1(client_);
            this.whoami = IAM.PLAYER1;
            return;
        }
        if (!this.player2) {
            await this._setPlayer2(client_);
            this.whoami = IAM.PLAYER2;
            return;
        }
        await this._addSpectator(client_);
        this.whoami = IAM.SPECTATOR;
    }

    public isPlayerLeave = (): boolean => {
        return this.whoami !== IAM.SPECTATOR;
    }

    public destroyRoom = async (): Promise<void> => {
        await this.ModelRecord.updateOne({ $set: { gameStatus: 2, finished: true } }).exec();
    }

    public spectatorLeave = async (socketId: Socket): Promise<void> => {
        this.spectators = this.spectators.filter(client => client.toString() !== socketId.id);
        await this.ModelRecord.updateOne({ $set: { spectators: this.spectators.map(s => s.toString()) } }).exec();
    }

    private _setPlayer1 = async (client: Client): Promise<void> => {
        this.player1 = client;
        this.player1.value = IAMValue.PLAYER1;

        await this.ModelRecord.updateOne({
            $set: {
                player1: client.socket.id,
                gameStatus: (this.player2) ? 1 : 0,
            },
        }).exec();
    }

    private _setPlayer2 = async (client: Client): Promise<void> => {
        this.player2 = client;
        this.player2.value = IAMValue.PLAYER2;

        await this.ModelRecord.updateOne({
            $set: {
                player2: client.socket.id,
                gameStatus: (this.player1) ? 1 : 0,
            },
        }).exec();
    }

    private _addSpectator = async (client: Client): Promise<void> => {
        this.spectators.push(client);

        await this.ModelRecord.updateOne({ spectators: this.spectators.map(client_ => client_.toString()) }).exec();
    }

    private _onlyPlayerAccess = (client: Socket): Client => {
        if (client.id == this.player1.toString()) {
            return this.player1;
        }
        if (client.id == this.player2.toString()) {
            return this.player2;
        }
        return null;
    }

    private translateFlatToIndex = (flatIndex: number) => {
        return {
            row: Math.floor(flatIndex / this.fieldSize),
            col: flatIndex % this.fieldSize,
        };
    }

    private translateIndexToFlat = (row: number, col: number): number => {
        return this.fieldSize * row + col;
    }
}

export default Game;
