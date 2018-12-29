var config = {};

// self explanatory, your application name, descriptions, etc
config.appName = 'FedoraGoldWallet';
config.appDescription = 'FedoraGold (FED) Wallet';
config.appSlogan = 'Welcome to The FED.';
config.appId = 'fed.fedoragold.walletshell';
config.appGitRepo = 'https://github.com/turtlecoin/turtle-wallet-electron';

// default port number for your daemon (e.g. fedoragold_daemon)
config.daemonDefaultRpcPort = 30159;

// wallet file created by this app will have this extension
config.walletFileDefaultExt = 'wal';

// change this to match your wallet service executable filename
config.walletServiceBinaryFilename = 'fedoragold_walletd';
config.daemonBinaryFilename = 'fedoragold_daemon';

// version on the bundled service (fedoragold_walletd)
config.walletServiceBinaryVersion = "v0.10.0";

// default port number for your wallet service (e.g. fedoragold_walletd)
config.walletServiceRpcPort = 9090;

// block explorer url, the [[TX_HASH] will be substituted w/ actual transaction hash
config.blockExplorerUrl = 'http://explorer.fedoragold.com/?hash=[[TX_HASH]]#blockchain_transaction';

// default remote node to connect to, set this to a known reliable node for 'just works' user experience
config.remoteNodeDefaultHost = '127.0.0.1'; // seed1

// remote node list update url, set to null if you don't have one
config.remoteNodeListUpdateUrl = null; //'https://raw.githubusercontent.com/turtlecoin/turtlecoin-nodes-json/master/turtlecoin-nodes.json';

// fallback remote node list, in case fetching update failed, fill this with known to works remote nodes
config.remoteNodeListFallback = [
    '18.223.178.174', // seed1
    '18.222.96.134',  // seed2
    '18.191.2.241',   // fuji
    '34.235.55.80'    // goblin
];

// your currency name
config.assetName = 'FedoraGold';
// your currency ticker
config.assetTicker =  'FED';
// your currency address prefix, for address validation
config.addressPrefix =  '';  // jojapoppa, should FED assume a prefix of "N"? if i add that does it chance the validatAddress() lenghts?
// standard wallet address length, for address validation
config.addressLength = 95;
// integrated wallet address length, for address validation
config.integratedAddressLength = 187;  //jojapoppa, what is this?

// minimum fee for sending transaction
config.minimumFee = 0.1;
// minimum amount for sending transaction
config.mininumSend = 0.1;
// default mixin/anonimity for transaction
config.defaultMixin = 3;
// to convert from atomic unit
config.decimalDivisor = 100000000;
// to represent human readable value
config.decimalPlaces = 8;

// obfuscate address book entries, set to false if you want to save it in plain json file.
// not for security because the encryption key is attached here
config.addressBookObfuscateEntries = true;
// key use to obfuscate address book contents
config.addressBookObfuscationKey = '79009fb00ca1b7130832a42de45142cf6c4b7f333fe6fba5';
// initial/sample entries to fill new address book
config.addressBookSampleEntries = [
    { name: 'somebody',
      address: 'FEDLuxEnfjdF46cBoHhyDtPN32weD9fvL43KX5cx2Ck9iSP4BLNPrJY3xtuFpXtLxiA6LDYojhF7n4SwPNyj9M64iTwJ738vnJk',
      paymentId: '', 
    }
];

module.exports = config;