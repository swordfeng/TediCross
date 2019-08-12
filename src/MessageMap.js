"use strict";

/**************************
 * Import important stuff *
 **************************/

const path = require("path");
const level = require("level-rocksdb");

/********************
 * Create the class *
 ********************/

/**
 * Handles mapping between message IDs in discord and telegram, for message editing purposes
 */
class MessageMap {
	constructor(dataDir) {
		this._db = level(path.join(dataDir, "messageMap"), { cacheSize: 64 * 1024 * 1024 });  // 64M Cache
	}

	async _pushValue(key, value) {
		const values = await this._db.get(key).then(JSON.parse).catch(() => []);

		if (values.indexOf(value) !== -1) return;

		values.push(value);
		await this._db.put(key, JSON.stringify(values));
	}

	/**
	 * Inserts a mapping into the map
	 *
	 * @param {String} direction	One of the two direction constants of this class
	 * @param {Bridge} bridge	The bridge this mapping is for
	 * @param {String} fromId	Message ID to map from, i.e. the ID of the message the bot received
	 * @param {String} toId	Message ID to map to, i.e. the ID of the message the bot sent
	 */
	async insert(direction, bridge, fromId, toId) {
		const insertEntry = this._pushValue(`${bridge.name} ${direction} ${fromId}`, toId);
		const insertReverseEntry = this._pushValue(`${bridge.name} ${direction} ${toId} reversed`, fromId);

		await insertEntry;
		await insertReverseEntry;
	}

	/**
	 * Gets the ID of a message the bot sent based on the ID of the message the bot received
	 *
	 * @param {String} direction	One of the two direction constants of this class
	 * @param {Bridge} bridge	The bridge this mapping is for
	 * @param {String} fromId	Message ID to get corresponding ID for, i.e. the ID of the message the bot received the message
	 *
	 * @returns {String[]}	Message IDs of the corresponding message, i.e. the IDs of the messages the bot sent
	 */
	async getCorresponding(direction, bridge, fromId) {
		try {
			return await this._db.get(`${bridge.name} ${direction} ${fromId}`).then(JSON.parse);
		} catch (err) {
			return [];
		}
	}

	async getCorrespondingReverse(direction, bridge, toId) {
		const reversedDirection = (direction == MessageMap.DISCORD_TO_TELEGRAM
			? MessageMap.TELEGRAM_TO_DISCORD : MessageMap.DISCORD_TO_TELEGRAM);
		try {
			return await this._db.get(`${bridge.name} ${reversedDirection} ${toId} reversed`).then(JSON.parse);
		} catch (err) {
			return [];
		}
	}

	/**
	 * Constant indicating direction discord to telegram
	 */
	static get DISCORD_TO_TELEGRAM() {
		return "d2t";
	}

	/**
	 * Constant indicating direction telegram to discord
	 */
	static get TELEGRAM_TO_DISCORD() {
		return "t2d";
	}
}

/********************
 * Export the class *
 ********************/

module.exports = MessageMap;
