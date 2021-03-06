/*******************************************************************************
*  Code contributed to the webinos project
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*
* Copyright 2011 Habib Virji, Samsung Electronics (UK) Ltd
*******************************************************************************/
/**
* @author <a href="mailto:habib.virji@samsung.com">Habib Virji</a>
* @description: Starts PZH farm and handles adding of new PZH
*/

var tls         = require("tls");
var path        = require("path");
var util        = require("util");
var fs          = require("fs");

var webinos = require("webinos")(__dirname);
var session = webinos.global.require(webinos.global.pzp.location, "lib/session");
var log     = new session.common.debug("pzh_farm");
var pzh     = require("./pzh_sessionHandling.js");

var farm = exports;

farm.pzhs = [];
farm.config = {};
farm.server;
farm.pzhWI  = webinos.global.require(webinos.global.pzh.location, "web/pzh_webserver");

function loadPzhs(config) {
  "use strict";
  var myKey;
  for ( myKey in config.pzhs) {
    if(typeof config.pzhs[myKey] !== "undefined") {
      pzh.addPzh(myKey, config.pzhs[myKey], function(res, instance) {
        if (res) {
          log.info("started PZH ... " + instance.config.name);
        } else {
          log.error("failed started PZH ... ");
        }
      });
    }
  }
}

/**
* @description: Starts farm.
* @param {string} url: pzh farm url for e.g. pzh.webinos.org
* @param {function} callback: true in case successful or else false in case unsuccessful
*/
farm.startFarm = function (url, name, callback) {
  "use strict";
  // The directory structure which pzh_farms needs for putting in files
  session.configuration.createDirectoryStructure(function(){
    // Configuration setting for pzh, returns set values and connection key
    session.configuration.setConfiguration(name,"PzhFarm", url, null, function (config, conn_key) {
      if (config === "undefined") {
        log.error("failed setting configuration, details are missing");
        return;
      }
      // Connection parameters for PZH pzh_farm TLS server.
      // Note this is the main server, pzh started are stored as SNIContext to this server
      farm.config = config;
      var options = {
        key  : conn_key,
        cert : farm.config.own.cert,
        ca   : farm.config.master.cert,
        requestCert       : true,
        rejectUnauthorised: false
      };
      session.common.resolveIP(url, function(resolvedAddress) {
        // Main pzh_farm TLS server
        farm.server = tls.createServer (options, function (conn) {
          // if servername existes in conn and pzh_farm.pzhs has details about pzh instance, message will be routed to respective PZH authorization function
          if (conn.servername && farm.pzhs[conn.servername]) {
            farm.pzhs[conn.servername].handleConnectionAuthorization(farm.pzhs[conn.servername], conn);
          } else {
            log.error("server Is Not Registered in Farm "+conn.servername);
            conn.socket.end();
            return;
          }
          // In case data is received at pzh_farm
          conn.on("data", function(data){
            // forward message to respective PZH handleData function
            if(conn.servername && farm.pzhs[conn.servername]) {
              farm.pzhs[conn.servername].handleData(conn, data);
            } else {
              log.info("("+conn.servername+") is not registered in the farm");
            }
          });
            // In case of error
          conn.on("end", function(err) {
            log.info("("+conn.servername+") client ended connection");
          });

          // It calls removeClient to remove PZH from list.
          conn.on("close", function() {
            try {
              log.info("("+conn.servername+") Pzh/Pzp  closed");
              if(conn.servername && farm.pzhs[conn.servername]) {
                var cl = farm.pzhs[conn.servername];
                var removed = session.common.removeClient(cl, conn);
                if (removed !== null && typeof removed !== "undefined"){
                  cl.messageHandler.removeRoute(removed, conn.servername);
                  cl.discovery.removeRemoteServiceObjects(removed);
                }
              }
            } catch (err) {
              log.error("("+conn.servername+") Remove client from connectedPzp/connectedPzh failed" + err);
            }
          });

          conn.on("error", function(err) {
            log.error("("+conn.servername+") General Error" + err);
          });
        });

        farm.server.on("listening", function(){
          log.info("initialized at " + resolvedAddress);
          // Load PZH"s that we already have registered ...
          loadPzhs(farm.config);
          // Start web interface, this webinterface will adapt depending on user who logins
          farm.pzhWI.start(url, function (status) {
            if (status) {
              callback(true, farm.config);
            }
          });
        });
        farm.server.listen(session.configuration.farmPort, resolvedAddress);
      });
    });
  });
};

/**
* @description: this function returns correct pzh id depending on user login details. If details are not present it adds information in config
* @param {string} url: pzh url
* @param {object} user: details fetched from openid about user
*/
farm.getOrCreatePzhInstance = function (host, user, callback) {
  "use strict";
  var name;

  if (typeof user.username === "undefined" || user.username === null ) {
    name = user.email;
  } else {
    name = user.username;
  }
  // Check for if user already existed and is stored
  var myKey = host+"/"+name;

  if ( farm.pzhs[myKey] && farm.pzhs[myKey].config.name === name ) {
    log.info("user already registered");
    callback(myKey, farm.pzhs[myKey]);
  } else if(farm.pzhs[myKey]) { // Cannot think of this case, but still might be useful
    log.info("user first time login");
    farm.pzhs[myKey].config.name     = name;
    farm.pzhs[myKey].config.email    = user.email;
    farm.pzhs[myKey].config.country  = user.country;
    farm.pzhs[myKey].config.image    = user.image;
    session.configuration.storeConfig(farm.pzhs[myKey].config, function() {
      callback(myKey, farm.pzhs[myKey]);
    });
  } else {
    log.info("adding new PZH - " + myKey);
    var pzhModules = session.configuration.pzhDefaultServices;
    pzh.addPzh(myKey, pzhModules, function(status){
      if (status) {
        farm.pzhs[myKey].config.name     = name;
        farm.pzhs[myKey].config.email    = user.email;
        farm.pzhs[myKey].config.country  = user.country;
        farm.pzhs[myKey].config.image    = user.image;
        session.configuration.storeConfig(farm.pzhs[myKey].config, function() {
          callback(myKey, farm.pzhs[myKey]);
        });
      } else {
        callback(myKey, null);
      }
    });
  }
};

