// Import libraries
var fs = require('fs'),
    path = require('path'),
    crypto = require('crypto'),
    moment = require('moment'),
    querystring = require('querystring'),
    tl = require('vsts-task-lib/task'),
    fileMatch = require('file-match'),
    request = require('request'),
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
const IncludedExtensions = tl.getDelimitedInput('extensions', ' ', true);

// User Optional Fields
const ExcludeFolders = tl.getDelimitedInput('exclude', ' ', false);
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
var filter = fileMatch(ExcludeFolders);
var httpsProxy = undefined;

// Run actual plugin work
runPlugin();

function runPlugin() {
    findProxySettings();
    var scannedFiles = scanAllFiles();
    var dependencies = getDependenciesFromFiles(scannedFiles.fileList);

    var checkPolicyComplianceRequest = createFullRequest(REQUEST_TYPE.CHECK_POLICY_COMPLIANCE, dependencies);
    console.log('Sending check policies request to WhiteSource server');
    sendRequest(checkPolicyComplianceRequest, onErrorRequest, function(responseBody) {
        tl.debug('Check policies response: ' + JSON.stringify(responseBody));
        onCheckPolicyComplianceSuccess(responseBody);
        var updateRequest = createFullRequest(REQUEST_TYPE.UPDATE, dependencies);
        sendUpdateRequest(updateRequest)
    });
}

function findProxySettings() {
    // find the actual proxy url
    var proxy = tl.getVariable('VSTS_HTTP_PROXY'); // usually undefined but check for backwards compatibility
    if (!proxy) {
        proxy = tl.getVariable('AGENT_PROXYURL');
    }

    if (proxy) {
        console.log('Proxy settings detected.');
        // check if there are proxy credentials and construct the proxy url with credentials
        if (tl.getVariable('AGENT_PROXYUSERNAME') && tl.getVariable('AGENT_PROXYPASSWORD')) {
            var index = proxy.lastIndexOf('://') + 3; // the actual index of '/'
            var authenticatedProxy = proxy.substr(0, index) + tl.getVariable('AGENT_PROXYUSERNAME') + ':' +
                tl.getVariable('AGENT_PROXYPASSWORD') + '@' + proxy.substr(index, proxy.length);
            httpsProxy = new httpsProxyAgent(authenticatedProxy);
            console.log('Proxy username and password found. Authenticated proxy url is: ' + authenticatedProxy);
        } else {
            httpsProxy = new httpsProxyAgent(proxy);
        }
    } else {
        tl.debug('No build agent proxy settings found.')
    }
}

function scanAllFiles() {
    console.log('Start discovering project folder files');
    var readDirObject = readDirRecursive(Cwd); // list the directory files recursively
    var notPermittedFolders = readDirObject.notPermittedFolders;

    if (notPermittedFolders.length !== 0) {
        console.log('Skipping the following folders due to insufficient permissions:');
        console.log('---------------------------------------------------------------');
        notPermittedFolders.forEach(function (folder) {
            console.log(folder);
        });
        console.log('---------------------------------------------------------------');
    }
    tl.debug('Scan files result: ' + JSON.stringify(readDirObject));
    console.log('Finished discovering all files');
    return readDirObject;
}

function getDependenciesFromFiles(files) {
    var dependencies = [];

    files.forEach(function (file) {
        var fullPath = file.path + path.sep + file.name;
        if (isFile(fullPath) && isExtensionRight(file.name)) {
            var lastModified = getLastModifiedDate(fullPath);
            var dependency = getDependencyInfo(file.name, fullPath, lastModified);
            if (dependency) {
                dependencies.push(dependency);
            }
        }
    });
    console.log('Suspected dependencies found: ' + dependencies.length);
    tl.debug('All suspected dependency infos: ' + JSON.stringify(dependencies));
    return dependencies;
}

function createFullRequest(requestType, dependencies) {
    var requestInventory = [{
        "coordinates": {
            "artifactId": ProjectName,
            "version": "1.0.0"
        },
        "dependencies": dependencies
    }];
    var body = createPostRequest(requestType) + "&diff=" + JSON.stringify(requestInventory);

    var request =  {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Charset': 'utf-8'
        },
        body: body,
        timeout: 3600000,
        method: 'post',
        url: DestinationUrl
    };

    if (httpsProxy) {
        request.agent = httpsProxy;
    }

    return request;
}

function createPostRequest(type) {
    return querystring.stringify({
        "agent": "tfs-plugin",
        "agentVersion": PLUGIN_VERSION,
        "type": type,
        "token": ServiceAuthorization.parameters.apitoken,
        "timeStamp": new Date().getTime(),
        "product": Product,
        "productVersion": ProductVersion,
        "requesterEmail": RequesterEmail,
        "projectToken": ProjectToken,
        "forceCheckAllDependencies": isForceCheckAllDependencies
    });
}

function sendRequest(fullRequest, onError, onSuccess) {
    tl.debug('Full post request as sent to server: ' + JSON.stringify(fullRequest));
    request(fullRequest, function (err, response, responseBody) {
        if (err && onError) {
            onError(err);
        }
        if (response) {
            var statusCode = response.statusCode;
            if ((statusCode >= 200 && statusCode < 300) || statusCode === 304) {
                if (onSuccess) {
                    onSuccess(responseBody);
                }
            } else if (statusCode === 407) {
                console.log('Build agent is unable to authenticate against the proxy server.' +
                    '\nPlease ask the Team Foundation administrator to add VSTS_HTTP_PROXY_USERNAME and ' +
                    'VSTS_HTTP_PROXY_PASSWORD as build agent environment variables.' +
                    '\nUnable to proceed with WhiteSource task.');
                console.log('##vso[task.complete result=Failed]');
                process.exit(1);
            } else if (statusCode === 403 && httpsProxy) {
                console.log('ERROR: Unable to send requests due to proxy restrictions.\n' +
                    'Please make sure to add "whitesourcesoftware.com" domain name and it\'s sub domains ' +
                    'to your proxy whitelist.');
                console.log('##vso[task.complete result=Failed]');
                process.exit(1);
            } else {
                console.log('Response status code ' + statusCode + '\nUnable to proceed with request');
                tl.debug('Entire http response is:\n' + JSON.stringify(response));
                console.log('Unable to proceed with WhiteSource task.');
                console.log('##vso[task.complete result=Failed]');
                process.exit(1);
            }
        }
    });
}

function onCheckPolicyComplianceSuccess(responseBody) {
    if (isJson(responseBody)) {
        if (responseBody.status === 2) { //STATUS_BAD_REQUEST
            logError('error', 'Server responded with status "Bad Request", Please check your credentials');
            logError('error', 'Terminating Build');
            process.exit(1);
        }
        else if (responseBody.status === 3) { //STATUS_SERVER_ERROR
            logError('error', 'Server responded with status "Server Error", please try again');
            logError('error', 'Terminating Build');
            process.exit(1);
        }
    } else {
        logError('error', 'Server responded with object other than "JSON"');
        logError('error', responseBody);
        logError('error', 'Terminating Build');
        process.exit(1);
    }

    try {
        var jsonResponse = JSON.parse(responseBody);
        var responseData =  JSON.parse(jsonResponse.data);
    } catch (err) {
        logError('error', 'Unable to parse check policy response data, error: ' + err);
    }

    if (responseData) {
        var rejectionList = getRejectionList(responseData);
        if (rejectionList.length !== 0) {
            logError('warning', "Found " + rejectionList.length + ' policy rejections');
            rejectionList.forEach(function (rejection) {
                logError('warning', 'Resource ' + rejection.resourceName  + ' was rejected by policy "' + rejection.policyName + '"');
            });
            foundRejections = true;
        }
        else {
            console.log('All dependencies conform with open source policies.');
        }
    }
}

function sendUpdateRequest(updateRequest) {
    if (foundRejections) {
        if (isForceUpdate === "true") {
            console.log('Sending force update inventory request to WhiteSource server');
            tl.debug('Full force update post request: ' + JSON.stringify(updateRequest));

            sendRequest(updateRequest, onErrorRequest, function (responseBody) {
                tl.debug("Force update response: " + JSON.stringify(responseBody));
                console.log('warning', "Inventory was updated even though some dependencies violate policies.");
                showUpdateServerResponse(responseBody);
            });
        } else {
            if (CheckPoliciesAction === "FAIL_ON_BUILD") {
                logError('error', 'Terminating Build upon policy violations');
                process.exit(1);
            }
        }
    } else {
        console.log('Sending update inventory request to WhiteSource server');
        sendRequest(updateRequest, onErrorRequest, function (responseBody) {
            tl.debug("Update request response: " + JSON.stringify(responseBody));
            showUpdateServerResponse(responseBody);
        });
    }
}

function onErrorRequest(err) {
    console.log("Error sending request:" + JSON.stringify(err));
}

function showUpdateServerResponse(response) {
    var jsonResponse = JSON.parse(response);
    var responseData;
    try {
        responseData = JSON.parse(jsonResponse.data);
    } catch (err){
        console.log("Error in updating WhiteSource: " + jsonResponse.data);
        process.exit(1);
    }

    if (responseData) {
        if (responseData.organization) {
            console.log('Organization ' + responseData.organization + ' was updated');
        }
        if (responseData.updatedProjects && responseData.updatedProjects.length > 0) {
            console.log('Updated projects ' + responseData.updatedProjects.join(','));
        } else {
            console.log('No project were updated');
        }
        if (responseData.createdProjects && responseData.createdProjects.length > 0) {
            console.log('Created projects ' + responseData.createdProjects.join(','));
        } else {
            console.log('No new project were created');
        }
        if (responseData.requestToken) {
            console.log('Support request token ' + responseData.requestToken);
        }
    }
}

function getRejectionList(data) {
    var rejectionList = [];
    createRejectionList(data);
    return rejectionList;

    // inner functions
    function createRejectionList(currentNode) {
        // the node is a leaf
        if (typeof currentNode === 'string') {
            return;
        }
        // the node is children array
        else if (Array.isArray(currentNode) && currentNode.length !== 0) {
            currentNode.forEach(function (child) {
                createRejectionList(child);
            })
        } else {
            // The node if object or empty array
            var objKeys = Object.keys(currentNode);
            if (objKeys.length !== 0) {
                // The node is non empty object
                var policyIndex = objKeys.indexOf('policy');
                // There is a rejected policy
                if (policyIndex !== -1 && currentNode.policy.actionType === 'Reject') {
                    var rejectionInfo = {
                            resourceName: currentNode.resource.displayName,
                            policyName: currentNode.policy.displayName
                        };
                    rejectionList.push(rejectionInfo);
                } else {
                    // Keep on going
                    objKeys.forEach(function (key) {
                        createRejectionList(currentNode[key]);
                    })
                }
            } else {
                // Empty object or array
                return;
            }
        }
    }
}

function getDependencyInfo(fileName, path, modified) {
    if(fileName.toLowerCase().match(constants.JS_SCRIPT_REGEX)) {

    }
    var sha1AndOtherPlatformSha1 = HashCalculator.getSha1(path);
    var hashCalculationResult = HashCalculator.calculateSuperHash(path, fileName);
    tl.debug("Complete calculating Sha1 of " + path + " sha1: " + sha1AndOtherPlatformSha1.sha1 + " Other Platform Sha1: " + sha1AndOtherPlatformSha1.otherPlatformSha1);
    if (hashCalculationResult != null) {
        tl.debug("fullFileHash: " + hashCalculationResult.fullHash + ", mostSigBitsHash: " + hashCalculationResult.mostSigBitsHash + ", leastSigBitsHash: " + hashCalculationResult.leastSigBitsHash);
    }
    return {
        "artifactId": fileName,
        "sha1": sha1AndOtherPlatformSha1.sha1,
        "otherPlatformSha1": sha1AndOtherPlatformSha1.otherPlatformSha1,
        "fullHash": (hashCalculationResult == null) ? null : hashCalculationResult.fullHash,
        "mostSigBitsHash": (hashCalculationResult == null) ? null : hashCalculationResult.mostSigBitsHash,
        "leastSigBitsHash": (hashCalculationResult == null) ? null : hashCalculationResult.leastSigBitsHash,
        "systemPath": path,
        "optional": false,
        "children": [],
        "exclusions": [],
        "licenses": [],
        "copyrights": [],
        "lastModified": modified
    };
}

function isJson(str) {
    try {
        JSON.parse(str);
    }
    catch (err) {
        logError('error', err);
        return false;
    }
    return true;
}

function readDirRecursive(dir, fileList) {
    var notPermittedFolders = [];
    try {
        var files = fs.readdirSync(dir);
    }
    catch (err) {
        logError('error', err);
        return {
            fileList: []
        };
    }

    fileList = fileList || [];
    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        try {
            fs.statSync(dir + path.sep + file).isDirectory();
        }
        catch (err) {
            logError('error', err);
            notPermittedFolders.push(file);
            continue;
        }

        var fullPath = dir + path.sep + file;
        if (filter(fullPath)) {
            //skip -> Exclude list
        }
        else if (fs.statSync(fullPath).isDirectory()) {
            readDirObject = readDirRecursive(fullPath, fileList);
            fileList = readDirObject.fileList;
        } else {
            fileList.push({'name': file, 'path': dir});
        }
    }
    return {
        fileList: fileList,
        notPermittedFolders: notPermittedFolders
    };
}

function isFile(path) {
    var stats = fs.statSync(path);
    return stats.isFile();
}

function isExtensionRight(file) {
    var fileExtension = path.extname(file);
    if (IncludedExtensions.indexOf(fileExtension) > -1) {
        return true;
    }
}

function getLastModifiedDate(path) {
    var stats = fs.statSync(path);
    return moment(stats.mtime).format("MMM D, YYYY h:mm:ss A")
}

function logError(type, str) {
    console.log('##vso[task.logissue type=' + type + ']' + str);
}