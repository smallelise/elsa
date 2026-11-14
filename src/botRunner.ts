import { PandoraApi } from 'pandora-api/api';
import {
	BotCommandRepository,
	BotConnection,
	CreateBotRepositoryCommand,
	SimpleBotOrchestrator,
	type BotSpaceCharacter,
	type BotSpaceState,
	type SimpleBotOrchestratorBotInstance,
} from 'pandora-api/bots';
import {
	Assert, GetLogger, type BotChatMessage, type CharacterId, type ChatMessageChatNPC, type SpaceId,
} from 'pandora-common';
import type { BotId, BotShardConnectionInfo } from 'pandora-common/bots';
import { ENV } from './config.ts';
import {ChallengeTypes} from "./enums/challengeType.ts";


const { ELSA_ID, ELSA_SHARD_BASE_ADDRESS } = ENV;
const logger = GetLogger('Elsa');

//region Global Helpers
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Collapses all whitespace (including newlines) so user text cannot fake additional lines in bot messages */
function CleanText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

const BOT_IDENTITY: ChatMessageChatNPC = { id: 'bot', name: 'Elsa', labelColor: '#EBEBEB' };

const HELP_MESSAGE =
	`Available commands:
	!help: Show this message`;

// endregion

export class Instance {
	//region Instance Globals
	public readonly conn: BotConnection;
	public readonly commands: BotCommandRepository;

	/** Serializes outgoing messages so they arrive in the order they were issued */
	public sendQueue: Promise<void> = Promise.resolve();

	/** Characters currently present in the space */
	public present = new Map<CharacterId, BotSpaceCharacter>();
	private readonly players: BotSpaceCharacter[] = [];

	/** Set on destroy; stops all further sending and long-running flows */
	public destroyed = false;

	//endregion

	//region Commands
	/*
	 * Return value convention for all commands
	 * true  = the command took effect (or there is nothing the user could fix), input is cleared
	 * false = the user should modify the command or retry later, input is kept
	 * All messages of a command are sent before the command finishes processing.
	 */
	constructor(conn: BotConnection) {
		this.conn = conn;
		this.commands = new BotCommandRepository()
			.registerCommand({
				key: 'help',
				description: 'Show the help~ who would have guessed?',
				handler: CreateBotRepositoryCommand().handler(async ({ character }): Promise<boolean> => {
					await this.whisper(character, HELP_MESSAGE);
					return true;
				}),
			})
	}
	//endregion

	//region Sending

	/** Queues the message immediately (so the order of calls is the order in chat) and resolves when it was sent. Never rejects. */
	private send(message: BotChatMessage): Promise<void> {
		const result = this.sendQueue.then(async () => {
			if (this.destroyed) return;
			try {
				(await this.conn.chatSender.sendMessage(message)).unwrap();
			} catch (err) {
				logger.error('Failed to send message', err);
			}
		});
		this.sendQueue = result;
		return result;
	}

	/** Public message */
	private emote(message: string): Promise<void> {
		return this.send({ type: 'emote', message, as: BOT_IDENTITY });
	}

	/** Private message to a single player */
	private whisper(to: BotSpaceCharacter, message: string): Promise<void> {
		return this.send({ type: 'chat', message, as: BOT_IDENTITY, to: [to.id] });
	}

	/** Name for printing into chat; appends the character id if another known character has the same name */
	private nameOf(player: BotSpaceCharacter): string {
		const name = player.name.toLowerCase();
		const sameName = new Set<CharacterId>([player.id]);
		for (const c of [...this.present.values(), ...this.players]) {
			if (c.name.toLowerCase() === name) sameName.add(c.id);
		}
		return sameName.size > 1 ? `${player.name} (${player.id})` : player.name;
	}

	//endregion



}


class ElsaBotInstance implements SimpleBotOrchestratorBotInstance {
	private readonly botConnection: BotConnection;
	private readonly instance: Instance;
	/** The space state listeners are currently bound to; a new object (after a reload) needs new listeners */
	private boundState: BotSpaceState | null = null;

	constructor(bot: BotId, space: SpaceId, connectionInfo: BotShardConnectionInfo) {
		let firstLoad = true;
		this.botConnection = new BotConnection(bot, space);
		this.instance = new Instance(this.botConnection);

		this.botConnection.withCommandRouter(this.instance.commands);
		this.botConnection.on('connectError', (err) => logger.warning('Error connecting', bot, space, err));

		this.botConnection.on('loaded', (spaceState) => {
			if (!firstLoad)
				return;

			Assert(spaceState === this.botConnection.gameState);

			firstLoad = false;
			logger.info('Space loaded successfully', bot, space);
		});

		this.botConnection.updateConnectionInfo(connectionInfo);
	}

	public disconnect(): void {
		this.botConnection.disconnect();
	}

	public updateConnectionInfo(newConnectionInfo: BotShardConnectionInfo): void {
		this.botConnection.updateConnectionInfo(newConnectionInfo);
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function RunBots(api: PandoraApi): Promise<void> {
	const tokenInfo = (await api.token.getCurrentTokenInfo()).unwrap();

	logger.info(`Authenticated as account ${tokenInfo.accountId} using token "${tokenInfo.tokenName}" (scopes: ${tokenInfo.tokenScopes.join(', ')})`);
	if (!tokenInfo.tokenScopes.includes('bots:run'))
		throw new Error('Specified token is missing the "bots:run" scope');

	const orchestrator = new SimpleBotOrchestrator(api, ELSA_ID, (bot, space, connectionInfo) => {
		logger.info('Spawning new connection for bot and space', bot, space, connectionInfo);
		return new ElsaBotInstance(bot, space, connectionInfo);
	}, ELSA_SHARD_BASE_ADDRESS);

	await orchestrator.start();
}
