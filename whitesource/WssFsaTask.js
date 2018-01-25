// Import libraries
var fs = require('fs'),
    path = require('path'),
    //crypto = require('crypto'),
    //moment = require('moment'),
    //querystring = require('querystring'),
    tl = require('vsts-task-lib/task'),
    //fileMatch = require('file-match'),
    //request = require('request'),
    httpsProxyAgent = require('https-proxy-agent');
var HashCalculator = require('./HashCalculator');
var constants = require('./constants');

// Plugin configuration params

const WsService = tl.getInput('WhiteSourceService', false);
const DestinationUrl = tl.getEndpointUrl(WsService, false);
const ServiceAuthorization = tl.getEndpointAuthorization(WsService, false);
const Cwd = tl.getPathInput('cwd', false);

// User Mandatory Fields
const CheckPoliciesAction = tl.getInput('checkPolicies', true);
const ProjectName = tl.getInput('projectName', true);
const IncludedExtensions = tl.getInput('extensions', true);

// User Optional Fields
const ExcludeFolders = tl.getInput('exclude', false);
const Product = tl.getInput('productNameOrToken', false);
const ProductVersion = tl.getInput('productVersion', false);
const RequesterEmail = tl.getInput('requesterEmail', false);
const ProjectToken = tl.getInput('projectToken', false);
const isForceCheckAllDependencies = tl.getInput('forceCheckAllDependencies', false);
const isForceUpdate = tl.getInput('forceUpdate', false);

// General global variables
const PLUGIN_VERSION = '18.1.1';
const REQUEST_TYPE = {
    CHECK_POLICY_COMPLIANCE: 'CHECK_POLICY_COMPLIANCE',
    UPDATE: 'UPDATE'
};

var foundRejections = false;
//var filter = fileMatch(ExcludeFolders);
var httpsProxy = undefined;
var useProxy = false; // Later
if (useProxy) {
    var proxyHost = tl.getInput('proxy', false);
    var proxyPort = tl.getInput('proxy', false);
    var proxyUser = tl.getInput('proxy', false);
    var proxyPass = tl.getInput('proxy', false);
}

// Run actual plugin work
runPlugin();

function runPlugin() {
    // Create the config file
    var cfgContent = '';
    cfgContent = cfgContent + "checkPolicies=" + CheckPoliciesAction + "\n";
    cfgContent = cfgContent + "forceCheckAllDependencies=" + isForceCheckAllDependencies + "\n";
    cfgContent = cfgContent + "forceUpdate=" + isForceUpdate + "\n";
    cfgContent = cfgContent + "wss.url=" + DestinationUrl + "\n";
    cfgContent = cfgContent + "apiKey=" + ServiceAuthorization.parameters.apitoken + "\n";
    cfgContent = cfgContent + "projectName=" + ProjectName + "\n";
    cfgContent = cfgContent + "projectVersion=" + "\n";
    cfgContent = cfgContent + "projectToken=" + ProjectToken + "\n";
    if (/^(([a-z0-9]{64})|([a-z0-9]{8}(-)[a-z0-9]{4}(-)[a-z0-9]{4}(-)[a-z0-9]{4}(-)[a-z0-9]{12}))$/.test(Product)) {
        cfgContent = cfgContent + "productToken=" + Product + "\n";
    } else {
        cfgContent = cfgContent + "productName=" + Product + "\n";
    }
    cfgContent = cfgContent + "productVersion=" + ProductVersion + "\n";
    cfgContent = cfgContent + "requesterEmail=" + RequesterEmail + "\n";

    var IncludedExtensionsGlob = '**/*.dll';
    if (IncludedExtensions) {
        IncludedExtensionsGlob = IncludedExtensions.replace(' .', '**/*.');
    }
    cfgContent = cfgContent + "includes=" + IncludedExtensionsGlob + "\n";

    var ExcludeFoldersGlob = '**/*sources.jar **/*javadoc.jar';
    if (ExcludeFolders) {
        ExcludeFoldersGlob = ExcludeFolders.replace(' .', '**/*.');
    }
    cfgContent = cfgContent + "excludes=" + ExcludeFoldersGlob + "\n";

    if (useProxy) {
        cfgContent = cfgContent + "proxy.host=" + proxyHost + "\n";
        cfgContent = cfgContent + "proxy.port=" + proxyPort + "\n";
        cfgContent = cfgContent + "proxy.user=" + proxyUser + "\n";
        cfgContent = cfgContent + "proxy.pass=" + proxyPass + "\n";
    }
    cfgContent = cfgContent + "offline=false" + "\n";
    cfgContent = cfgContent + "updateType=OVERRIDE" + "\n";
    cfgContent = cfgContent + "case.sensitive.glob=false" + "\n";
    cfgContent = cfgContent + "followSymbolicLinks=true" + "\n";

    fs.writeFile('whitesource-fs-agent.config', cfgContent, (err) => {
        if (err) throw err;
    });

    var bla = 'Bla';
}