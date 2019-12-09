/* eslint no-empty: 0 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const childProcess = require('child_process');
const log = require('electron-log');
const Store = require('electron-store');
const WalletShellSession = require('./ws_session');
const WalletShellApi = require('./ws_api');
const uiupdater = require('./wsui_updater');
const wsutil = require('./ws_utils');
const config = require('./ws_config');
const remote = require('electron').remote;

const settings = new Store({name: 'Settings'});
const wsession = new WalletShellSession();

const SERVICE_LOG_DEBUG = wsession.get('debug');
const SERVICE_LOG_LEVEL_DEFAULT = 0;
const SERVICE_LOG_LEVEL_DEBUG = 4;
const SERVICE_LOG_LEVEL = (SERVICE_LOG_DEBUG ? SERVICE_LOG_LEVEL_DEBUG : SERVICE_LOG_LEVEL_DEFAULT);
const ERROR_WALLET_EXEC = `Failed to start ${config.walletServiceBinaryFilename}.`;
const ERROR_WALLET_PASSWORD = 'Failed to load your wallet, possible password issue';
const ERROR_WALLET_IMPORT = 'Import failed, please check that you have entered all information correctly';
const ERROR_WALLET_CREATE = 'Wallet can not be created, please check your input and try again';

const INFO_FUSION_DONE = 'Wallet optimization completed, your balance may appear incorrect for a while.';
const INFO_FUSION_SKIPPED = 'Wallet already optimized. No further optimization is needed.';
const ERROR_FUSION_FAILED = 'Unable to optimize your wallet, please try again in a few seconds';

let SVC_BIN = '';
let plat = process.platform;
let daemonCoreReady = false;

// make sure nodejs allocates enough threads for sending and receiving transactions
process.env.UV_THREADPOOL_SIZE = 128;

const SVC_FILENAME =  (plat === 'win32' ? `${config.walletServiceBinaryFilename}.exe` : config.walletServiceBinaryFilename );
const SVC_OSDIR = (plat === 'win32' ? 'win' : (plat === 'darwin' ? 'mac' : 'linux'));
const DEFAULT_SVC_BIN = path.join(process.resourcesPath,'bin', SVC_OSDIR, SVC_FILENAME);
if (plat === 'darwin') {
  SVC_BIN = DEFAULT_SVC_BIN;
}
else {
  SVC_BIN = settings.get('service_bin');
}

var WalletShellManager = function(){
    if (!(this instanceof WalletShellManager)){
        return new WalletShellManager();
    }

    this.daemonHost = settings.get('daemon_host');
    this.daemonPort = settings.get('daemon_port');
    this.serviceProcess = null;
    this.serviceBin = SVC_BIN;
    this.walletdPassword = settings.get('walletd_password');
    this.walletdHost = settings.get('walletd_host');
    this.walletdPort = settings.get('walletd_port');
    this.serviceArgsDefault = [];
    this.walletConfigDefault = {'rpc-password': settings.get('walletd_password')};
    this.servicePid = null;
    this.serviceLastPid = null;
    this.serviceActiveArgs = [];
    this.serviceApi =  null;
    this.syncWorker = null;
    this.fusionTxHash = [];
};

WalletShellManager.prototype.init = function(password){
    this._getSettings();
    if(this.serviceApi !== null) return;
    
    let cfg = {
        daemon_host: this.daemonHost,
        daemon_port: this.daemonPort,
        walletd_host: this.walletdHost,
        walletd_port: this.walletdPort,
        walletd_password: password,
        daemonCoreReady: this.daemonCoreReady
    };
    this.serviceApi = new WalletShellApi(cfg);
};

WalletShellManager.prototype._getSettings = function(){
    this.daemonHost = settings.get('daemon_host');
    this.daemonPort = settings.get('daemon_port');
};

WalletShellManager.prototype._reinitSession = function(){
    wsession.reset();
    // remove wallet config
    let configFile = wsession.get('walletConfig');
    //log.warn("configFile is: "+configFile);
    if(configFile) try{ fs.unlinkSync(configFile); }catch(e){}
    this.notifyUpdate({
        type: 'sectionChanged',
        data: 'reset-oy'
    });
};

// check 
WalletShellManager.prototype.serviceStatus = function(){
    return  (undefined !== this.serviceProcess && null !== this.serviceProcess);
};

WalletShellManager.prototype.isRunning = function () {
    let proc = path.basename(this.serviceBin);
    let platform = process.platform;
    let cmd = '';
    switch (platform) {
        case 'win32' : cmd = `tasklist`; break;
        case 'darwin' : cmd = `ps -ax | grep ${proc}`; break;
        case 'linux' : cmd = `ps -A`; break;
        default: break;
    }
    if(cmd === '' || proc === '') return false;

    childProcess.exec(cmd, (err, stdout, stderr) => {
        if(err) log.debug(err.message);
        if(stderr) log.debug(stderr.toLocaleLowerCase());
        let found = stdout.toLowerCase().indexOf(proc.toLowerCase()) > -1;
        log.debug(`Process found: ${found}`);
        return found;
    });
};

WalletShellManager.prototype._writeIniConfig = function(cfg){
    let configFile = wsession.get('walletConfig');
    if(!configFile) return '';

    try{
        fs.writeFileSync(configFile, cfg);
        return configFile;
    }catch(err){
        log.error(err);
        return '';
    }
};

WalletShellManager.prototype._writeConfig = function(cfg){
    let configFile = wsession.get('walletConfig');
    if(!configFile) return '';

    cfg = cfg || {};
    if(!cfg) return '';

    let configData = '';
    Object.keys(cfg).map((k) => { configData += `${k}=${cfg[k]}${os.EOL}`;});
    try{
        fs.writeFileSync(configFile, configData);
        return configFile;
    }catch(err){
        log.error(err);
        return '';
    }
};

WalletShellManager.prototype.startService = function(walletFile, password, onError, onSuccess, onDelay){
    this.init(password);

    if(null !== this.serviceLastPid){
        // try to kill last process, in case it was stalled
        log.debug(`Trying to clean up old/stalled process, target pid: ${this.serviceLastPid}`);
        try{
            process.kill(this.serviceLastPid, 'SIGKILL');
        }catch(e){}
    }

    if(this.syncWorker) this.stopSyncWorker();

    // SERVICE_LOG_LEVEL,
    let serviceArgs = this.serviceArgsDefault.concat([
        '-w', walletFile,
        '-p', password,
        '--log-level', 0,
        '--address'
    ]);

    if(SERVICE_LOG_LEVEL > 0) {
        serviceArgs.push('--log-file');
        serviceArgs.push(logFile(walletFile));
    }

    let wsm = this;
   
    childProcess.execFile(this.serviceBin, serviceArgs, {timeout:5000}, (error, stdout, stderr) => {
            if(stderr) log.error(stderr);

            let addressLabel = "Address: "; 
            if(stdout && stdout.length && stdout.indexOf(addressLabel) !== -1){
                let trimmed = stdout.trim();
                let walletAddress = trimmed.substring(trimmed.indexOf(addressLabel)+
                  addressLabel.length, trimmed.length);
                wsession.set('loadedWalletAddress', walletAddress);

                // the first call just got the address back... now we run it for reals
                wsm._spawnService(walletFile, password, onError, onSuccess, onDelay);
            }else{
                // just stop here
                onError(ERROR_WALLET_PASSWORD+": "+stderr);
            }
        }
    );
};

WalletShellManager.prototype._argsToIni = function(args) {
    let configData = "";
    if("object" !== typeof args || !args.length) return configData;
    args.forEach((k,v) => {
        let sep = ((v%2) === 0) ? os.EOL : "=";
        configData += `${sep}${k.toString().replace('--','')}`;
    });
    return configData.trim();
};

function logFile(walletFile) {
    let file = path.basename(walletFile);
    return path.join( path.dirname(walletFile), `${file.split(' ').join('').split('.')[0]}.log`);
}

WalletShellManager.prototype._spawnService = function(walletFile, password, onError, onSuccess, onDelay) {

    var tblock = 0;
    var topb = settings.get('top_block');
    if (remote.app.primarySeedHeight > 0 && remote.app.primarySeedHeight > topb) {
      tblock = remote.app.primarySeedHeight;
    } else {
      tblock = topb;
    }

    var cblock = settings.get('current_block');
    var priority = remote.app.primarySeedAddr;
    var pri = remote.app.primarySeedPort;
    var daemonAd = priority;
    var daemonPt = 30159;
    var priNode = priority+":"+pri;

    // Determins if the local daemon is almost current
    //if ((cblock > 0) && (tblock > 0) && ((5000 + cblock) > tblock)) {
    //  daemonAd = '127.0.0.1';
    //  daemonPt = settings.get('daemon_port');
    //}

    log.warn("priNode: "+priNode);
    log.warn("daemon address: "+daemonAd);

    // all walletd's always run with --local, meaning it uses the seeds instead of
    //   the local daemon.  this allows people with slow machines to work, and yet
    //   still creates as many full daemons as physically possible.  once layer 3
    //   is up, i will add a --seed param below and make the location of that
    //   remote daemon dynamic, instead of relying on hardcoded seed addresses.
    var serviceArgs = this.serviceArgsDefault.concat([
        '--data-dir', remote.app.getPath('userData'),
        '--container-file', walletFile,
        '--container-password', password,
        '--bind-address', '127.0.0.1',
        '--bind-port', this.walletdPort,
        '--rpc-user', 'fedadmin',
        '--rpc-password', password,
        '--add-priority-node', priNode,
        '--allow-local-ip','',
        '--daemon-address', daemonAd,
        '--daemon-port', daemonPt,
        '--log-level', 0
        ]);

        //log.warn("walletFile: "+walletFile);
        //'--enable-cors', '*',

    let wsm = this;
    //log.warn("fedoragold's external network is accessed on port: 30158");
    //log.warn("this fedoragold_daemon is on port: "+settings.get('daemon_port'));
    //log.warn("this fedoragold_walletd is on port: "+this.walletdPort);

    try{
        this.serviceProcess = childProcess.spawn(wsm.serviceBin, serviceArgs,
          {detached: false, stdio: ['ignore','pipe','pipe'], encoding: 'utf-8'});
        this.servicePid = this.serviceProcess.pid;

        this.serviceProcess.stdout.on('data', function(chunk) {
        //  log.warn(chunk.toString());
        });
        this.serviceProcess.stderr.on('data', function(chunk) {
        //  log.warn(chunk.toString());
        });
    }catch(e){
        if(onError) onError(ERROR_WALLET_EXEC);
        log.error(`${config.walletServiceBinaryFilename} is not running`);
        return false;
    }
    
    this.serviceProcess.on('close', () => {
        this.terminateService(true);
        log.debug(`${config.walletServiceBinaryFilename} closed`);
    });

    this.serviceProcess.on('error', (err) => {
        this.terminateService(true);
        wsm.syncWorker.stopSyncWorker();
        log.warn(`${config.walletServiceBinaryFilename} error: ${err.message}`);
    });

    if(!this.serviceStatus()){
        if(onError) onError(ERROR_WALLET_EXEC);
        log.error(`${config.walletServiceBinaryFilename} is not running`);
        return false;
    }

    let TEST_OK = false;
    let MAX_CHECK = 48;
    function testConnection(retry){
        wsm.serviceApi.getAddress().then((address) => {
            //log.warn('Got an address, wallet is ok!');
            if(!TEST_OK){
                wsm.serviceActiveArgs = serviceArgs;
                // update session
                wsession.set('loadedWalletAddress', address);
                wsession.set('serviceReady', true);
                wsession.set('connectedNode', `${settings.get('daemon_host')}:${settings.get('daemon_port')}`);
                // start the worker here?
                wsm.startSyncWorker(password);
                wsm.notifyUpdate({
                    type: 'addressUpdated',
                    data: address
                });

                onSuccess(walletFile);
                TEST_OK = true;
            }
            return true;
        }).catch((err) => {
            //log.debug('Walletd connection failed or timedout');
            if(retry === 10 && onDelay) onDelay(`Still no response from ${config.walletServiceBinaryFilename}, please wait a few more seconds...`);
            if(retry >= MAX_CHECK && !TEST_OK){
                if(wsm.serviceStatus()){
                    wsm.terminateService();
                }
                wsm.serviceActiveArgs = [];
                onError(err);
                return false;
            }else{
                setTimeout(function(){
                    let nextTry = retry+1;
                    log.debug(`retrying testconn (${nextTry})`);
                    testConnection(nextTry);
                }, 1800);
            }
        });
    }

    setTimeout(function(){
        testConnection(0);
    }, 15000);
};

WalletShellManager.prototype.stopService = function(){
    let wsm = this;
    return new Promise(function (resolve){
        if(wsm.serviceStatus()){
            wsm.serviceLastPid = wsm.serviceProcess.pid;
            wsm.stopSyncWorker();
            wsm.serviceApi.save().then(() =>{
                try{
                    wsm.terminateService(true);
                    wsm._reinitSession();
                    resolve(true);
                }catch(err){
                    log.warn(`SIGTERM failed: ${err.message}`);
                    wsm.terminateService(true);
                    wsm._reinitSession();
                    resolve(false);
                }
            }).catch((err) => {
                //log.warn(`Failed to save wallet: ${err.message}`);
                // try to wait for save to completed before force killing
                setTimeout(()=>{
                    wsm.terminateService(true); // force kill
                    wsm._reinitSession();
                    resolve(true);
                },10000);
            });
        } else {
            wsm._reinitSession();
            resolve(false);
        }
    });
};

WalletShellManager.prototype.terminateService = function(force) {
    if(!this.serviceStatus()) return;
    force = force || false;
    let signal = force ? 'SIGKILL' : 'SIGTERM';
    //log.debug(`terminating with ${signal}`);
    this.serviceLastPid = this.servicePid;
    try{
        this.serviceProcess.kill(signal);
        if(this.servicePid) process.kill(this.servicePid, signal);
    }catch(e){
        if(!force && this.serviceProcess) {
            log.debug(`SIGKILLing ${config.walletServiceBinaryFilename}`);
            try{this.serviceProcess.kill('SIGKILL');}catch(err){}
            if(this.servicePid){
                try{process.kill(this.servicePid, 'SIGKILL');}catch(err){}
            }
        }
    }
    
    this.serviceProcess = null;
    this.servicePid = null;
};

WalletShellManager.prototype.startSyncWorker = function(password){

    let wsm = this;
    if(this.syncWorker !== null){
        this.syncWorker = null;
        try{wsm.syncWorker.kill('SIGKILL');}catch(e){}
    }

    this.syncWorker = childProcess.fork(
        path.join(__dirname,'./ws_syncworker.js')
    );
    
    this.syncWorker.on('message', (msg) => {
        if(msg.type === 'serviceStatus' ){
            wsm.syncWorker.send({
                type: 'start',
                data: {}
            });
            wsession.set('serviceReady', true);
            wsession.set('syncStarted', true);
        }else{
            wsm.notifyUpdate(msg);
        }
    });

    this.syncWorker.on('close', function (){
        wsm.syncWorker = null;
        try{wsm.syncWorker.kill('SIGKILL');}catch(e){}
        log.debug(`service worker terminated.`);
    });

    this.syncWorker.on('exit', function (){
        wsm.syncWorker = null;
        log.debug(`service worker exited.`);
    });

    this.syncWorker.on('error', function(err){
        try{wsm.syncWorker.kill('SIGKILL');}catch(e){}
        wsm.syncWorker = null;
        log.debug(`service worker error: ${err.message}`);
    });

    let cfgData = {
        type: 'cfg',
        data: {
            daemon_host: this.daemonHost,
            daemon_port: this.daemonPort,
            walletd_host: this.walletdHost,
            walletd_port: this.walletdPort,
            walletd_password: password
        },
        debug: SERVICE_LOG_DEBUG
    };
    this.syncWorker.send(cfgData);
};

WalletShellManager.prototype.stopSyncWorker = function(){
    if(null === this.syncWorker) return;

    try{
        this.syncWorker.send({type: 'stop', data: {}});
        this.syncWorker.kill('SIGTERM');
        this.syncWorker  = null;
    }catch(e){
        log.debug(`syncworker already stopped`);
    }
};

WalletShellManager.prototype.getNodeFee = function(){
    let wsm = this;
    
    this.serviceApi.getFeeInfo().then((res) => {
        let theFee;
        if(!res.amount || !res.address){
            theFee = 0;
        }else{
            theFee = (res.amount / config.decimalDivisor);
        }
        wsession.set('nodeFee', theFee);
        if(theFee <= 0) return theFee;
        
        wsm.notifyUpdate({
            type: 'nodeFeeUpdated',
            data: theFee
        });
        return theFee;
    }).catch((err) => {
        log.debug(`failed to get node fee: ${err.message}`);
        return 0;
    });
};

//jojapoppa, didn't know default max length to give integratedaddresses, this shows what it is...
WalletShellManager.prototype.genIntegratedAddress = function(paymentId, address){
    let wsm = this;
    return new Promise((resolve, reject) => {
        address = address || wsession.get('loadedWalletAddress');
        let params = {address: address, paymentId: paymentId};
        wsm.serviceApi.createIntegratedAddress(params).then((result) =>{
            return resolve(result);
        }).catch((err)=>{
            return reject(err);
        });
    });
};

WalletShellManager.prototype.createWallet = function(walletFile, password){
    let wsm = this;
    let walletLog = `.${walletFile}.log`;
    return new Promise((resolve, reject) => {
        let serviceArgs = wsm.serviceArgsDefault.concat(
            ['--container-file', walletFile, '--container-password', password, '--log-level', SERVICE_LOG_LEVEL, '--generate-container']
        );

        if(SERVICE_LOG_LEVEL > 0) {
           serviceArgs.push('--log-file');
           serviceArgs.push(logFile(walletFile));
        }

        //confirm(wsm.serviceBin);
        //confirm(serviceArgs);

        childProcess.execFile(
            wsm.serviceBin, serviceArgs, {timeout:5000}, (error, stdout, stderr) => {
                if(stdout) log.debug(stdout);
                if(stderr) log.error(stderr);
                if (error){
                    log.error(`Failed to create wallet: ${error.message}`);
                    return reject(new Error(error.message));
                    //return reject(new Error(ERROR_WALLET_CREATE));
                } else {
                    if(!wsutil.isRegularFileAndWritable(walletFile)){
                        let errMsg = `${walletFile} is invalid or unreadable`;
                        log.error(errMsg);
                        return reject(new Error(errMsg));
                    }
                    return resolve(walletFile);
                }
            }
        );
    });
};

WalletShellManager.prototype.importFromKeys = function(walletFile, password, viewKey, spendKey, scanHeight){
    let wsm = this;
    return new Promise((resolve, reject) => {
        scanHeight = scanHeight || 0;

	// jojapoppa - keys params not supported... what is this feature?
        let serviceArgs = wsm.serviceArgsDefault.concat([
            '-g', '-w', walletFile, '-p', password,
            '--view-key', viewKey, '--spend-key', spendKey,
        ]);

        if(scanHeight > 1024) serviceArgs = serviceArgs.concat(['--scan-height',scanHeight]);

        childProcess.execFile(
            wsm.serviceBin, serviceArgs, (error, stdout, stderr) => {
                if(stdout) log.debug(stdout);
                if(stderr) log.error(stderr);
                if (error){
                    log.debug(`Failed to import key: ${error.message}`);
                    return reject(new Error(ERROR_WALLET_IMPORT));
                } else {
                    if(!wsutil.isRegularFileAndWritable(walletFile)){
                        return reject(new Error(ERROR_WALLET_IMPORT));
                    }
                    return resolve(walletFile);
                }
            }
        );

    });
};

WalletShellManager.prototype.importFromSeed = function(walletFile, password, mnemonicSeed, scanHeight){
    let wsm = this;
    return new Promise((resolve, reject) => {
        scanHeight = scanHeight || 0;

	// jojapoppa - this is not supported i think... check.  "seed" means
	// loads wallet from blockchain (no local storage) - very risky feature
	// ... i'm not sure i like it.  even if we did this the webpage it
	// loads from would need to be distributed somehow... dunno about this...
	// for now, this nmematic seed web wallet feature is commented out
        let serviceArgs = wsm.serviceArgsDefault.concat([
            '-g', '-w', walletFile, '-p', password,
            '--mnemonic-seed', mnemonicSeed,
        ]);

        if(scanHeight > 1024) serviceArgs = serviceArgs.concat(['--scan-height',scanHeight]);

        childProcess.execFile(
            wsm.serviceBin, serviceArgs, (error, stdout, stderr) => {
                if(stdout) log.debug(stdout);
                if(stderr) log.error(stderr);

                if (error){
                    log.debug(`Error importing seed: ${error.message}`);
                    return reject(new Error(ERROR_WALLET_IMPORT));
                } else {
                    if(!wsutil.isRegularFileAndWritable(walletFile)){
                        return reject(new Error(ERROR_WALLET_IMPORT));
                    }
                    return resolve(walletFile);
                }
            }
        );
    });
};

WalletShellManager.prototype.getSecretKeys = function(address){
    let wsm = this;
    return new Promise((resolve, reject) => {
        wsm.serviceApi.getBackupKeys({address: address}).then((result) => {
            return resolve(result);
        }).catch((err) => {
            log.debug(`Failed to get keys: ${err.message}`);
            return reject(err);
        });
    });
};

WalletShellManager.prototype.sendTransaction = function(params){
    let wsm = this;
    return new Promise((resolve, reject) => {
        wsm.serviceApi.sendTransaction(params).then((result) => {
            return resolve(result);
        }).catch((err) => {
            return reject(err);
        });
    });
};

WalletShellManager.prototype.reset = function(){
    let wsm = this;
    let params = {};
    //log.warn("WalletShellManager: reset");
    wsm.syncWorker.send({ type: 'reset', data: {} });
};

WalletShellManager.prototype._fusionGetMinThreshold = function(threshold, minThreshold, maxFusionReadyCount, counter){
    let wsm = this;
    return new Promise((resolve, reject) => {
        counter = counter || 0;
        threshold = threshold || (parseInt(wsession.get('walletUnlockedBalance'),10)*100)+1;
        threshold = parseInt(threshold,10);
        minThreshold = minThreshold || threshold;
        maxFusionReadyCount = maxFusionReadyCount || 0;
        
        let maxThreshCheckIter = 20;

        wsm.serviceApi.estimateFusion({threshold: threshold}).then((res)=>{
            // nothing to optimize
            if( counter === 0 && res.fusionReadyCount === 0) return resolve(0); 
            // stop at maxThreshCheckIter or when threshold too low
            if( counter > maxThreshCheckIter || threshold < 10) return resolve(minThreshold);
            // we got a possibly best minThreshold
            if(res.fusionReadyCount < maxFusionReadyCount){
                return resolve(minThreshold);
            }
            // continue to find next best minThreshold
            maxFusionReadyCount = res.fusionReadyCount;
            minThreshold = threshold;
            threshold /= 2;
            counter += 1;
            resolve(wsm._fusionGetMinThreshold(threshold, minThreshold, maxFusionReadyCount, counter).then((res)=>{
                return res;
            }));
        }).catch((err)=>{
            return reject(new Error(err));
        });
    });
};

WalletShellManager.prototype._fusionSendTx = function(threshold, counter){
    let wsm = this;
    return new Promise((resolve, reject) => {
        counter = counter || 0;
        let maxIter = 256;
        if(counter >= maxIter) return resolve(wsm.fusionTxHash); // stop at max iter
        
        // keep sending fusion tx till it hit IOOR or reaching max iter 
        log.debug(`send fusion tx, iteration: ${counter}`);
        wsm.serviceApi.sendFusionTransaction({threshold: threshold}).then((resp)=> {
            wsm.fusionTxHash.push(resp.transactionHash);
            counter +=1;
            return resolve(wsm._fusionSendTx(threshold, counter).then((resp)=>{
                return resp;
            }));
        }).catch((err)=>{
            return reject(new Error(err));
        });
    });
};

WalletShellManager.prototype.optimizeWallet = function(){
    let wsm = this;
    return new Promise( (resolve, reject) => {
        wsm.fusionTxHash = [];
        wsm._fusionGetMinThreshold().then((res)=>{
            if(res <= 0 ){
                wsm.notifyUpdate({
                    type: 'fusionTxCompleted',
                    data: INFO_FUSION_SKIPPED
                });
                return resolve(INFO_FUSION_SKIPPED);
            }

            log.debug(`performing fusion tx, threshold: ${res}`);
            return resolve(
                wsm._fusionSendTx(res).then(() => {
                    wsm.notifyUpdate({
                        type: 'fusionTxCompleted',
                        data: INFO_FUSION_DONE
                    });
                    return INFO_FUSION_DONE;
                }).catch((err)=>{
                    let msg = err.message.toLowerCase();
                    let outMsg = ERROR_FUSION_FAILED;
                    switch(msg){
                        case 'index is out of range':
                            outMsg = wsm.fusionTxHash.length >=1 ? INFO_FUSION_DONE : INFO_FUSION_SKIPPED;
                            break;
                        default:
                            break;
                    }
                    wsm.notifyUpdate({
                        type: 'fusionTxCompleted',
                        data: outMsg
                    });
                    return outMsg;
                })
            );
        }).catch((err)=>{
            return reject((err.message));
        });
    });
};

//WalletShellManager.prototype.networkStateUpdate = function(state){
//    if(!this.syncWorker) return;    
//    log.debug('ServiceProcess PID: ' + this.servicePid);
//    if(state === 0){
//        // pause the syncworker, but leave service running
//        this.syncWorker.send({
//            type: 'pause',
//            data: null
//        });
//    }else{
// WHY CALL INIT() HERE?        this.init();
//
//        // looks like fedoragold_walletd always stalled after disconnected, just kill & relaunch it
//        let pid = this.serviceProcess.pid || null;
//        this.terminateService();
//        // wait a bit
//        setImmediate(() => {
//            if(pid){
//                try{process.kill(pid, 'SIGKILL');}catch(e){}
//            }
//            setTimeout(()=>{
//                log.debug(`respawning ${config.walletServiceBinaryFilename}`);
//                this.serviceProcess = childProcess.spawn(this.serviceBin, this.serviceActiveArgs);
//                // store new pid
//                this.servicePid = this.serviceProcess.pid;
//                this.syncWorker.send({
//                    type: 'resume',
//                    data: null
//                });
//            },15000);
//        },2500);        
//    }
//};

WalletShellManager.prototype.notifyUpdate = function(msg){
//    log.warn(`in notifyUpdate ... calling updateUiState: ${msg.type}`);
    uiupdater.updateUiState(msg);
};

WalletShellManager.prototype.resetState = function(){
    return this._reinitSession();
};

module.exports = WalletShellManager;
