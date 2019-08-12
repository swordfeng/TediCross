"use strict";

/**************************
 * Import important stuff *
 **************************/

const Discord = require("discord.js");
const md2html = require("./md2html");
const MessageMap = require("../MessageMap");
const LatestDiscordMessageIds = require("./LatestDiscordMessageIds");
const handleEmbed = require("./handleEmbed");
const relayOldMessages = require("./relayOldMessages");
const Bridge = require("../bridgestuff/Bridge");
const path = require("path");
const R = require("ramda");

/***********
 * Helpers *
 ***********/

/**
 * Creates a function to give to 'guildMemberAdd' or 'guildMemberRemove' on a Discord bot
 *
 * @param {Logger} logger	The Logger instance to log messages to
 * @param {String} verb	Either "joined" or "left"
 * @param {BridgeMap} bridgeMap	Map of existing bridges
 * @param {Telegraf} tgBot	The Telegram bot to send the messages to
 *
 * @returns {Function}	Function which can be given to the 'guildMemberAdd' or 'guildMemberRemove' events of a Discord bot
 *
 * @private
 */
function makeJoinLeaveFunc(logger, verb, bridgeMap, tgBot) {
	// Find out which setting property to check the bridges for
	const relaySetting = verb === "joined"
		? "relayJoinMessages"
		: "relayLeaveMessages"
	;

	return function(member) {
		// Get the bridges in the guild the member joined/left
		member.guild.channels
			// Get the bridges corresponding to the channels in this guild
			.map(({id}) => bridgeMap.fromDiscordChannelId(id))
			// Remove the ones which are not bridged
			.filter((bridges) => bridges !== undefined)
			// Flatten the bridge arrays
			.reduce(((flattened, bridges) => flattened.concat(bridges)))
			// Remove those which do not allow relaying join messages
			.filter((bridge) => bridge.discord[relaySetting])
			// Ignore the T2D bridges
			.filter((bridge) => bridge.direction !== Bridge.DIRECTION_TELEGRAM_TO_DISCORD)
			.forEach(async (bridge) => {
				// Make the text to send
				const text = `<b>${member.displayName} (@${member.user.username})</b> ${verb} the Discord side of the chat`;

				try {
					// Send it
					await tgBot.telegram.sendMessage(
						bridge.telegram.chatId,
						text,
						{
							parse_mode: "HTML"
						}
					);
				} catch (err) {
					logger.error(`[${bridge.name}] Could not notify Telegram about a user that ${verb} Discord`, err);
				}
			});
	};
}

/**********************
 * The setup function *
 **********************/

/**
 * Sets up the receiving of Discord messages, and relaying them to Telegram
 *
 * @param {Logger} logger	The Logger instance to log messages to
 * @param {Discord.Client} dcBot	The Discord bot
 * @param {Telegraf} tgBot	The Telegram bot
 * @param {MessageMap} messageMap	Map between IDs of messages
 * @param {BridgeMap} bridgeMap	Map of the bridges to use
 * @param {Settings} settings	Settings to use
 * @param {String} datadirPath	Path to the directory to put data files in
 */
function setup(logger, dcBot, tgBot, messageMap, bridgeMap, settings, datadirPath) {
	// Create the map of latest message IDs and bridges
	const latestDiscordMessageIds = new LatestDiscordMessageIds(logger, path.join(datadirPath, "latestDiscordMessageIds.json"));
	const useNickname = settings.discord.useNickname;

	// Listen for users joining the server
	dcBot.on("guildMemberAdd", makeJoinLeaveFunc(logger, "joined", bridgeMap, tgBot));

	// Listen for users joining the server
	dcBot.on("guildMemberRemove", makeJoinLeaveFunc(logger, "left", bridgeMap, tgBot));

	// Listen for Discord messages
	dcBot.on("message", async (message) => {

		// Ignore the bot's own messages
		if (message.author.id === dcBot.user.id) {
			return;
		}

		// Check if this is a request for server info
		if (message.channel.type === "text" && message.cleanContent === "/chatinfo") {
			// It is. Give it
			message.reply(
				"serverId: '" + message.guild.id + "'\n" +
				"channelId: '" + message.channel.id + "'\n"
			);

			// Don't process the message any further
			return;
		}

		// Get info about the sender
		const senderName = (useNickname && message.member ? message.member.displayName : message.author.username) + (settings.telegram.colonAfterSenderName ? ":" : "");

		// Check if the message is from the correct chat
		const bridges = bridgeMap.fromDiscordChannelId(message.channel.id);
		if (!R.isEmpty(bridges)) {
			bridges.forEach(async (bridge) => {
				// Ignore it if this is a telegram-to-discord bridge
				if (bridge.direction === Bridge.DIRECTION_TELEGRAM_TO_DISCORD) {
					return;
				}

				// This is now the latest message for this bridge
				latestDiscordMessageIds.setLatest(message.id, bridge);

				// Check for attachments and pass them on
				message.attachments.forEach(async ({url}) => {
					try {
						const textToSend = bridge.discord.sendUsernames
							? `<b>${senderName}</b>\n<a href="${url}">${url}</a>`
							: `<a href="${url}">${url}</a>`
						;
						const tgMessage = await tgBot.telegram.sendMessage(
							bridge.telegram.chatId,
							textToSend,
							{
								parse_mode: "HTML"
							}
						);
						await messageMap.insert(MessageMap.DISCORD_TO_TELEGRAM, bridge, message.id, tgMessage.message_id);
					} catch (err) {
						logger.error(`[${bridge.name}] Telegram did not accept an attachment:`, err);
					}
				});

				// Check the message for embeds
				message.embeds.forEach((embed) => {
					// Ignore it if it is not a "rich" embed (image, link, video, ...)
					if (embed.type !== "rich") {
						return;
					}

					// Convert it to something Telegram likes
					const text = handleEmbed(embed, senderName);

					try {
						// Send it
						tgBot.telegram.sendMessage(
							bridge.telegram.chatId,
							text,
							{
								parse_mode: "HTML",
								disable_web_page_preview: true
							}
						);
					} catch (err) {
						logger.error(`[${bridge.name}] Telegram did not accept an embed:`, err);
					}
				});

				// Check if there is an ordinary text message
				if (message.cleanContent) {

					// Modify the message to fit Telegram
					const processedMessage = md2html(message.cleanContent);

					// Pass the message on to Telegram
					try {
						// Workaround for Discord GIFs
						if (processedMessage.startsWith("https://tenor.com/view/")) {
							const channel = bridge.telegram.tempChannel || bridge.telegram.chatId;
							const tgVideoMessage = await tgBot.telegram.sendVideo(
								channel,
								processedMessage
							);
							await tgBot.telegram.deleteMessage(channel, tgVideoMessage.message_id);
						}

						const textToSend = bridge.discord.sendUsernames
							? `<b>${senderName}</b>\n${processedMessage}`
							: processedMessage
						;
						const tgMessage = await tgBot.telegram.sendMessage(
							bridge.telegram.chatId,
							textToSend,
							{
								parse_mode: "HTML"
							}
						);

						// Make the mapping so future edits can work
						await messageMap.insert(MessageMap.DISCORD_TO_TELEGRAM, bridge, message.id, tgMessage.message_id);

					} catch (err) {
						logger.error(`[${bridge.name}] Telegram did not accept a message:`, err);
						logger.error(`[${bridge.name}] Failed message:`, err);
					}
				}
			});
		} else if (R.isNil(message.channel.guild) || !bridgeMap.knownDiscordServer(message.channel.guild.id)) {	// Check if it is the correct server
			// The message is from the wrong chat. Inform the sender that this is a private bot
			message.reply(
				"This is an instance of a TediCross bot, bridging a chat in Telegram with one in Discord. "
				+ "If you wish to use TediCross yourself, please download and create an instance. "
				+ "See https://github.com/TediCross/TediCross"
			);
		}
	});

	// Listen for message edits
	dcBot.on("messageUpdate", async (oldMessage, newMessage) => {
		// Don't do anything with the bot's own messages
		if (newMessage.author.id === dcBot.user.id) {
			return;
		}

		// Pass it on to the bridges
		bridgeMap.fromDiscordChannelId(newMessage.channel.id).forEach(async (bridge) => {
			try {
				// Get the corresponding Telegram message ID
				const [tgMessageId] = await messageMap.getCorresponding(MessageMap.DISCORD_TO_TELEGRAM, bridge, newMessage.id);

				// Get info about the sender
				const senderName = (useNickname && newMessage.member ? newMessage.member.displayName : newMessage.author.username) + (settings.telegram.colonAfterSenderName ? ":" : "");

				// Modify the message to fit Telegram
				const processedMessage = md2html(newMessage.cleanContent);

				// Send the update to Telegram
				const textToSend = bridge.discord.sendUsernames
					? `<b>${senderName}</b>\n${processedMessage}`
					: processedMessage
				;
				await tgBot.telegram.editMessageText(
					bridge.telegram.chatId,
					tgMessageId,
					null,
					textToSend,
					{
						parse_mode: "HTML"
					}
				);
			} catch (err) {
				logger.error(`[${bridge.name}] Could not edit Telegram message:`, err);
			}
		});
	});

	// Listen for deleted messages
	function onMessageDelete(message) {
		// Check if it is a relayed message
		const isFromTelegram = message.author.id === dcBot.user.id;

		// Hand it on to the bridges
		bridgeMap.fromDiscordChannelId(message.channel.id).forEach(async (bridge) => {
			// Ignore it if cross deletion is disabled
			if (!bridge.discord.crossDeleteOnTelegram) {
				return;
			}

			try {
				// Get the corresponding Telegram message IDs
				const tgMessageIds = await (isFromTelegram
					? messageMap.getCorrespondingReverse(MessageMap.DISCORD_TO_TELEGRAM, bridge, message.id)
					: messageMap.getCorresponding(MessageMap.DISCORD_TO_TELEGRAM, bridge, message.id)
				);

				// Try to delete them
				await Promise.all(
					tgMessageIds.map((tgMessageId) => tgBot.telegram.deleteMessage(bridge.telegram.chatId, tgMessageId))
				);
			} catch (err) {
				logger.error(`[${bridge.name}] Could not delete Telegram message:`, err);
			}
		});
	}
	dcBot.on("messageDelete", onMessageDelete);
	dcBot.on("messageDeleteBulk", (messages) => [...messages.values()].forEach(onMessageDelete));

	// Start the Discord bot
	dcBot.login(settings.discord.token)
		// Complain if it could not authenticate for some reason
		.catch((err) => logger.error("Could not authenticate the Discord bot:", err));

	// Listen for the 'disconnected' event
	dcBot.on("disconnected", async (evt) => {
		logger.error("Discord bot disconnected!", evt);

		bridgeMap.bridges.forEach(async (bridge) => {
			try {
				await tgBot.telegram.sendMessage(
					bridge.telegram.chatId,
					"**TEDICROSS**\nThe discord side of the bot disconnected! Please check the log"
				);
			} catch (err) {
				logger.error(`[${bridge.name}] Could not send message to Telegram:`, err);
			}
		});
	});

	// Listen for errors
	dcBot.on("error", (err) => {
		if (err.code === "ECONNRESET") {
			// Lost connection to the discord servers
			logger.warn("Lost connection to Discord's servers. The bot will resume when connection is reestablished, which should happen automatically. If it does not, please report this to the TediCross support channel");
		} else {
			// Unknown error. Tell the user to tell the devs
			logger.error("The Discord bot ran into an error. Please post the following error message in the TediCross support channel");
			logger.error(err);
		}
	});

	// Listen for debug messages
	if (settings.debug) {
		dcBot.on("debug", (str) => {
			logger.log(str);
		});

		// Check the Discord bot's status every now and then
		setInterval(() => {
			if (dcBot.status !== Discord.Constants.Status.READY) {
				let actualStatus = null;
				switch (dcBot.status) {
					case Discord.Constants.Status.CONNECTING:
						actualStatus = "CONNECTING";
						break;
					case Discord.Constants.Status.RECONNECTING:
						actualStatus = "RECONNECTING";
						break;
					case Discord.Constants.Status.IDLE:
						actualStatus = "IDLE";
						break;
					case Discord.Constants.Status.NEARLY:
						actualStatus = "NEARLY";
						break;
					case Discord.Constants.Status.DISCONNETED:
						actualStatus = "DISCONNECTED";
						break;
					default:
						actualStatus = "UNKNOWN";
						break;
				}
				logger.error(`Discord status not ready! Status is '${actualStatus}'`);
			}
		}, 1000);
	}

	// Make a promise which resolves when the dcBot is ready
	dcBot.ready = new Promise((resolve) => {
		// Listen for the 'ready' event
		dcBot.once("ready", () => {
			// Log the event
			logger.info(`Discord: ${dcBot.user.username} (${dcBot.user.id})`);

			// Mark the bot as ready
			resolve();
		});
	});

	// Relay old messages, if wanted by the user
	if (!settings.discord.skipOldMessages) {
		dcBot.ready = relayOldMessages(logger, dcBot, latestDiscordMessageIds, bridgeMap);
	}
}

/*****************************
 * Export the setup function *
 *****************************/

module.exports = setup;
