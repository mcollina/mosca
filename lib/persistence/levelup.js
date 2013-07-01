"use strict";

var levelup = require("levelup");
var sublevel = require("level-sublevel");
var AbstractPersistence = require("./abstract");
var util = require("util");
var range = require('level-range');
var ttl = require('level-ttl');
var Qlobber = require("qlobber").Qlobber;
var async = require("async");

/**
 * A LevelUp-based persistance.
 *
 * The current options include:
 *  - `path`, the path to the database
 *  - `ttl`, an object containing three values:
 *    * `checkFrequency`, the frequency at which the
 *      the expiration will be checked. It defaults to 1 minute.
 *    * `subscriptions`, the time (ms) after which subscriptions
 *      will expire. It defaults to 1 hour.
 *    * `packets`, the time (ms) after which packets will expire.
 *      It defaults to 1 hour.
 *  - `db`, the AbstractLevelDown implementation.
 *  - all other `levelup` otions.
 *
 * @api public
 * @param {Object} options The options to create this persistance
 * @param {Function} callback Called when ready.
 */
function LevelUpPersistence(options, callback) {
  if (!(this instanceof LevelUpPersistence)) {
    return new LevelUpPersistence(options, callback);
  }
  options = options || {};
  options.valueEncoding = "json";
  options.ttl = options.ttl || {};

  // TTL for subscriptions is 1 hour
  options.ttl.subscriptions = options.ttl.subscriptions || 60 * 60 * 1000;

  // TTL for packets is 1 hour
  options.ttl.packets = options.ttl.packets || 60 * 60 * 1000;

  // the checkFrequency is 1 minute
  options.ttl.checkFrequency = options.ttl.checkFrequency || 60 * 1000;

  this.options = options;
  this.db = ttl(levelup(options.path, options), options.ttl);
  this._retained = this.db.sublevel("retained");
  this._clientSubscriptions = this.db.sublevel("clientSubscriptions");
  this._subscriptions = this.db.sublevel("subscriptions");
  this._offlinePackets = this.db.sublevel("offlinePackets");
  this._subLobber = new Qlobber({ separator: "/" });

  var that = this;
  var stream = this._subscriptions.createReadStream();
  stream.on("data", function(data) {
    that._subLobber.add(data.value.topic, data.key);
  });
  stream.on("end", function() {
    if (callback) {
      callback(null, that);
    }
  });
}

util.inherits(LevelUpPersistence, AbstractPersistence);

/**
 * Private methods, not inteded to be called from outside
 *
 * @api private
 */

LevelUpPersistence.prototype.storeRetained = function(packet, cb) {
  this._retained.put(packet.topic, packet, cb);
};

LevelUpPersistence.prototype.lookupRetained = function(pattern, cb) {
  var stream = this._retained.createReadStream();
  var matched = [];
  var qlobber = new Qlobber({ separator: '/' });
  qlobber.add(pattern, true);

  stream.on("error", cb);

  stream.on("end", function() {
    cb(null, matched);
  });

  stream.on("data", function(data) {
    if (qlobber.match(data.key).length > 0) {
      matched.push(data.value);
    }
  });
};

LevelUpPersistence.prototype.storeSubscriptions = function(client, done) {
  var that = this;
  var ttl = {
    ttl: that.options.ttl.subscriptions
  };
  var subscriptions = {};

  if (!client.clean) {
    Object.keys(client.subscriptions).forEach(function(key) {
      if (client.subscriptions[key].qos > 0) {
        subscriptions[key] = client.subscriptions[key];
      }
    });
    this._clientSubscriptions.put(client.id, subscriptions, ttl, done);
    Object.keys(subscriptions).forEach(function(key) {
      var sub = {
        client: client.id,
        topic: key,
        qos: subscriptions[key].qos
      };
      var levelKey = util.format("%s:%s", key, client.id);
      that._subLobber.add(key, levelKey);
      that._subscriptions.put(levelKey, sub, ttl);
    });
  } else if (done) {
    done();
  }
};

var nop = function() {};
LevelUpPersistence.prototype.lookupSubscriptions = function(client, done) {
  var that = this;
  this._clientSubscriptions.get(client.id, function(err, subscriptions) {
    if (subscriptions && client.clean) {
      that._clientSubscriptions.del(client.id, function() {
        that.streamOfflinePackets(client, nop, function() {
          Object.keys(subscriptions).forEach(function(key) {
            var levelKey = util.format("%s:%s", key, client.id);
            that._subLobber.remove(levelKey);
            that._subscriptions.del(levelKey);
          });

          if (done) {
            done(null, {});
          }
        });
      });
    } else {
      if (!subscriptions) {
        subscriptions = {};
      }

      if (done) {
        done(null, subscriptions);
      }
    }
  });
};

LevelUpPersistence.prototype.storeOfflinePacket = function(packet, done) {
  var that = this;
  var subs = this._subLobber.match(packet.topic);

  async.each(subs, function(key, cb) {
    that._subscriptions.get(key, function(err, sub) {
      if (err) {
        return cb(err);
      }
      that._storePacket(sub.client, packet, cb);
    });
  }, done);
};

LevelUpPersistence.prototype.streamOfflinePackets = function(client, cb, done) {

  var that = this;
  var stream = range(that._offlinePackets, '%s:', client.id);
  stream.on("data", function(data) {
    var key = util.format('%s:%s', client.id, data.key);
    that._offlinePackets.del(key, function() {
      if (!client.clean) {
        cb(null, data.value);
      }
    });
  });

  if (cb) {
    stream.on("error", cb);
  }

  if (done) {
    stream.on("end", done);
  }
};

LevelUpPersistence.prototype._storePacket = function(client, packet, cb) {
  var key = util.format("%s:%s", client, new Date().toISOString());
  var ttl = {
    ttl: this.options.ttl.subscriptions
  };
  this._offlinePackets.put(
    key, packet, ttl, cb);
};

LevelUpPersistence.prototype.close = function(cb) {
  this.db.close(cb);
};

/**
 * Export it as a module
 *
 * @api public
 */
module.exports = LevelUpPersistence;
