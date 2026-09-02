"use strict";

const path = require('path');
const WebSocket = require('ws');
const protobuf = require("protobufjs");
const { EventEmitter } = require('events');
const Camera = require('./camera');

class RustPlus extends EventEmitter {

    /**
     * @param server The ip address or hostname of the Rust Server
     * @param port The port of the Rust Server (app.port in server.cfg)
     * @param playerId SteamId of the Player
     * @param playerToken Player Token from Server Pairing
     * @param useFacepunchProxy True to use secure websocket via Facepunch's proxy, or false to directly connect to Rust Server
     *
     * Events emitted by the RustPlus class instance
     * - connecting: When we are connecting to the Rust Server.
     * - connected: When we are connected to the Rust Server.
     * - message: When an AppMessage has been received from the Rust Server.
     * - request: When an AppRequest has been sent to the Rust Server.
     * - disconnected: When we are disconnected from the Rust Server.
     * - error: When something goes wrong.
     */
    constructor(server, port, playerId, playerToken, useFacepunchProxy = false) {

        super();

        this.server = server;
        this.port = port;
        this.playerId = playerId;
        this.playerToken = playerToken;
        this.useFacepunchProxy = useFacepunchProxy;

        this.seq = 0;
        this.seqCallbacks = [];

    }

    /**
     * This sets everything up and then connects to the Rust Server via WebSocket.
     */
    connect() {

        // load protobuf then connect
        protobuf.load(path.resolve(__dirname, "rustplus.proto")).then((root) => {

            // make sure existing connection is disconnected before connecting again.
            if(this.websocket){
                this.disconnect();
            }

            // load proto types
            this.AppRequest = root.lookupType("rustplus.AppRequest");
            this.AppMessage = root.lookupType("rustplus.AppMessage");

            // fire event as we are connecting
            this.emit('connecting');

            // connect to websocket
            var address = this.useFacepunchProxy ? `wss://companion-rust.facepunch.com/game/${this.server}/${this.port}` : `ws://${this.server}:${this.port}`;
            this.websocket = new WebSocket(address);

            // fire event when connected
            this.websocket.on('open', () => {
                this.emit('connected');
            });

            // fire event for websocket errors
            this.websocket.on('error', (e) => {
                this.emit('error', e);
            });

            this.websocket.on('message', (data) => {
                try {
                    // decode received message
                    var message = this.AppMessage.decode(data);

                    // check if received message is a response and if we have a callback registered for it
                    if(message.response && message.response.seq && this.seqCallbacks[message.response.seq]){

                        // get the callback for the response sequence
                        var callback = this.seqCallbacks[message.response.seq];

                        // call the callback with the response message
                        var result = callback(message);

                        // remove the callback
                        delete this.seqCallbacks[message.response.seq];

                        // if callback returns true, don't fire message event
                        if(result){
                            return;
                        }

                    }

                    // fire message event for received messages that aren't handled by callback
                    this.emit('message', message);
                } catch (decodeErr) {
                    console.warn("[RustPlus Protobuf] Decode error caught safely:", decodeErr.message);
                }
            });

            // fire event when disconnected
            this.websocket.on('close', () => {
                this.emit('disconnected');
            });

        });

    }

    /**
     * Disconnect from the Rust Server.
     */
    disconnect() {
        if(this.websocket){
            this.websocket.terminate();
            this.websocket = null;
        }
    }

    /**
     * Check if RustPlus is connected to the server.
     * @returns {boolean}
     */
    isConnected() {
        return !!(this.websocket && this.websocket.readyState === WebSocket.OPEN);
    }

    /**
     * Send a Request to the Rust Server with an optional callback when a Response is received.
     * @param data this should contain valid data for the AppRequest packet in the rustplus.proto schema file
     * @param callback
     */
    sendRequest(data, callback) {

        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            const err = new Error("WebSocket is not connected");
            if (callback) {
                return callback({ response: { error: { error: err.message } } });
            }
            throw err;
        }

        // increment sequence number
        let currentSeq = ++this.seq;

        // save callback if provided
        if(callback){
            this.seqCallbacks[currentSeq] = callback;
        }

        // create protobuf from AppRequest packet
        let request = this.AppRequest.fromObject({
            seq: currentSeq,
            playerId: this.playerId,
            playerToken: this.playerToken,
            ...data, // merge in provided data for AppRequest
        });

        // send AppRequest packet to rust server
        this.websocket.send(this.AppRequest.encode(request).finish());

        // fire event when request has been sent, this is useful for logging
        this.emit('request', request);

    }

    /**
     * Send a Request to the Rust Server and return a Promise
     * @param data this should contain valid data for the AppRequest packet defined in the rustplus.proto schema file
     * @param timeoutMilliseconds milliseconds before the promise will be rejected. Defaults to 10 seconds.
     */
    sendRequestAsync(data, timeoutMilliseconds = 10000) {
        return new Promise((resolve, reject) => {

            // reject promise after timeout
            var timeout = setTimeout(() => {
                reject(new Error('Timeout reached while waiting for response'));
            }, timeoutMilliseconds);

            try {
                // send request
                this.sendRequest(data, (message) => {

                    // cancel timeout
                    clearTimeout(timeout);

                    if(!message || !message.response) {
                        return reject(new Error("Invalid response received"));
                    }

                    if(message.response.error){
                        // reject promise if server returns an AppError for this request
                        reject(message.response.error);
                    } else {
                        // request was successful, resolve with message.response
                        resolve(message.response);
                    }

                });
            } catch (err) {
                clearTimeout(timeout);
                reject(err);
            }

        });
    }

    /**
     * Send a Request to the Rust Server to set the Entity Value.
     * @param entityId the entity id to set the value for
     * @param value the value to set on the entity
     * @param callback
     */
    setEntityValue(entityId, value, callback) {
        const payload = {
            entityId: entityId,
            setEntityValue: {
                value: value,
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Turn a Smart Switch On
     * @param entityId the entity id of the smart switch to turn on
     * @param callback
     */
    turnSmartSwitchOn(entityId, callback) {
        return this.setEntityValue(entityId, true, callback);
    }

    /**
     * Turn a Smart Switch Off
     * @param entityId the entity id of the smart switch to turn off
     * @param callback
     */
    turnSmartSwitchOff(entityId, callback) {
        return this.setEntityValue(entityId, false, callback);
    }

    /**
     * Quickly turn on and off a Smart Switch as if it were a Strobe Light.
     */
    strobe(entityId, timeoutMilliseconds = 100, value = true) {
        this.setEntityValue(entityId, value);
        setTimeout(() => {
            this.strobe(entityId, timeoutMilliseconds, !value);
        }, timeoutMilliseconds);
    }

    /**
     * Send a message to Team Chat
     * @param message the message to send to team chat
     * @param callback
     */
    sendTeamMessage(message, callback) {
        const payload = {
            sendTeamMessage: {
                message: message,
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get info for an Entity
     * @param entityId the id of the entity to get info of
     * @param callback
     */
    getEntityInfo(entityId, callback) {
        const payload = {
            entityId: entityId,
            getEntityInfo: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get the Map
     * @param callback
     */
    getMap(callback) {
        const payload = {
            getMap: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }
    
    /**
     * Get the in-game time
     * @param callback
     */
    getTime(callback) {
        const payload = {
            getTime: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get all map markers
     * @param callback
     */
    getMapMarkers(callback) {
        const payload = {
            getMapMarkers: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get the server info
     * @param callback
     */
    getInfo(callback) {
        const payload = {
            getInfo: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get team info
     * @param callback
     */
    getTeamInfo(callback) {
        const payload = {
            getTeamInfo: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get team chat history
     * @param callback
     */
    getTeamChat(callback) {
        const payload = {
            getTeamChat: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Promote a team member to leader
     * @param steamId
     * @param callback
     */
    promoteToLeader(steamId, callback) {
        const payload = {
            promoteToLeader: {
                steamId: String(steamId),
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Check notification subscription
     * @param callback
     */
    checkSubscription(callback) {
        const payload = {
            checkSubscription: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Set notification subscription
     * @param value
     * @param callback
     */
    setSubscription(value, callback) {
        const payload = {
            setSubscription: {
                value: !!value,
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get Clan Info
     * @param callback
     */
    getClanInfo(callback) {
        const payload = {
            getClanInfo: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Set Clan Message of the Day
     * @param message
     * @param callback
     */
    setClanMotd(message, callback) {
        const payload = {
            setClanMotd: {
                message: message,
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get Clan Chat History
     * @param callback
     */
    getClanChat(callback) {
        const payload = {
            getClanChat: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Send Clan Message
     * @param message
     * @param callback
     */
    sendClanMessage(message, callback) {
        const payload = {
            sendClanMessage: {
                message: message,
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get Nexus Auth Token
     * @param appKey
     * @param callback
     */
    getNexusAuth(appKey, callback) {
        const payload = {
            getNexusAuth: {
                appKey: appKey,
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Subscribes to a Camera
     * @param identifier Camera Identifier, such as OILRIG1 (or custom name)
     * @param callback
     */
    subscribeToCamera(identifier, callback) {
        const payload = {
            cameraSubscribe: {
                cameraId: identifier,
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Unsubscribes from a Camera
     * @param callback
     */
    unsubscribeFromCamera(callback) {
        const payload = {
            cameraUnsubscribe: {},
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Sends camera input to the server (mouse movement)
     * @param buttons The buttons that are currently pressed
     * @param x The x delta of the mouse movement
     * @param y The y delta of the mouse movement
     * @param callback
     */
    sendCameraInput(buttons, x, y, callback) {
        const payload = {
            cameraInput: {
                buttons: buttons,
                mouseDelta: {
                    x: x,
                    y: y,
                }
            },
        };
        if (typeof callback !== "function") {
            return this.sendRequestAsync(payload);
        }
        this.sendRequest(payload, callback);
    }

    /**
     * Get a camera instance for controlling CCTV Cameras, PTZ Cameras and Auto Turrets
     * @param identifier Camera Identifier, such as DOME1, OILRIG1L1, (or a custom camera id)
     * @returns {Camera}
     */
    getCamera(identifier) {
        return new Camera(this, identifier);
    }

}

module.exports = RustPlus;
