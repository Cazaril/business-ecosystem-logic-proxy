var async = require('async'),
    config = require('./../../config'),
    equal = require('deep-equal'),
    http = require('./../../lib/httpClient'),
    log = require('./../../lib/logger').logger.getLogger("Root"),
    storeClient = require('./../../lib/store').storeClient,
    tmfUtils = require('./../../lib/tmfUtils'),
    url = require('url'),
    utils = require('./../../lib/utils');


var ordering = (function(){

    var CUSTOMER = 'Customer';
    var SELLER = 'Seller';

    var ACKNOWLEDGED = 'Acknowledged';
    var IN_PROGRESS = 'InProgress';
    var COMPLETED = 'Completed';
    var FAILED = 'Failed';
    var PARTIAL = 'Partial';

    //////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////// COMMON ///////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////////////////////////////

    var makeRequest = function(rawUrl, errMsg, callback) {

        var parsedUrl = url.parse(rawUrl);

        var options = {
            host: parsedUrl.hostname,
            port: parsedUrl.port || 80,
            path: parsedUrl.path,
            method: 'GET'
        };

        var protocol = parsedUrl.protocol.indexOf('https') >= 0 ? 'https' : 'http';

        http.request(protocol, options, null, function(err, result) {

            if (err) {
                callback({
                    status: 400,
                    message: errMsg
                });
            } else {
                callback(err, JSON.parse(result.body));
            }
        });
    };

    //////////////////////////////////////////////////////////////////////////////////////////////
    ///////////////////////////////////////// RETRIEVAL //////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////////////////////////////

    var validateRetrieving = function(req, callback) {
        tmfUtils.filterRelatedPartyFields(req, callback);
    };


    //////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////// CREATION //////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////////////////////////////

    var completeRelatedPartyInfo = function(item, user, callback) {

        if (!item.product) {

            callback({
                status: 400,
                message: 'The product order item ' + item.id + ' must contain a product field'
            });

            return;
        }

        if (!item.productOffering) {

            callback({
                status: 400,
                message: 'The product order item ' + item.id + ' must contain a productOffering field'
            });

            return;
        }

        if (!item.product.relatedParty) {
            item.product.relatedParty = [];
        }
        var itemCustCheck = tmfUtils.isOrderingCustomer(user, item.product);

        if (itemCustCheck[0] && !itemCustCheck[1]) {
            callback({
                status: 403,
                message: 'The customer specified in the order item ' + item.id + ' is not the user making the request'
            });
            return;
        }

        if (!itemCustCheck[0]) {
            item.product.relatedParty.push({
                id: user.id,
                role: CUSTOMER,
                href: ''
            });
        }

        // Inject customer and seller related parties in the order items in order to make this info
        // available thought the inventory API

        var errorMessageOffer = 'The system fails to retrieve the offering attached to the ordering item ' + item.id;
        var errorMessageProduct = 'The system fails to retrieve the product attached to the ordering item ' + item.id;

        makeRequest(item.productOffering.href, errorMessageOffer, function(err, offering) {

            if (err) {
                callback(err);
            } else {

                makeRequest(offering.productSpecification.href, errorMessageProduct, function(err, product) {

                    if (err) {
                        callback(err);
                    } else {

                        var owners = product.relatedParty.filter(function (relatedParty) {
                            return relatedParty['role'].toLowerCase() === 'owner';
                        });

                        if (!owners) {
                            callback({
                                status: 400,
                                message: 'You cannot order a product without owners'
                            });

                        } else {
                            owners.forEach(function (owner) {
                                item.product.relatedParty.push({
                                    id: owner.id,
                                    role: SELLER,
                                    href: ''
                                });
                            });

                            callback(null, item);
                        }
                    }
                });

            }
        });
    };

    var validateCreation = function(req, callback) {
        var body;

        // The request body may not be well formed
        try {
            body = JSON.parse(req.body);
        } catch (e) {

            callback({
                status: 400,
                message: 'The resource is not a valid JSON document'
            });

            return; // EXIT
        }

        // Check that the related party field has been included
        if (!body.relatedParty) {

            callback({
                status: 400,
                message: 'A product order must contain a relatedParty field'
            });

            return;
        }

        // Check that the user has the customer role
        if (!tmfUtils.checkRole(req.user, config.oauth2.roles.customer)) {

            callback({
                status: 403,
                message: 'You are not authorized to order products'
            });

            return; // EXIT
        }

        // Check that the user is the specified customer
        var customerCheck = tmfUtils.isOrderingCustomer(req.user, body);
        if (!customerCheck[0]) {
            callback({
                status: 403,
                message: 'It is required to specify a customer in the relatedParty field'
            });

            return; // EXIT
        }

        if (!customerCheck[1]) {
            callback({
                status: 403,
                message: 'The customer specified in the product order is not the user making the request'
            });

            return; // EXIT
        }

        if (!body.orderItem) {
            callback({
                status: 400,
                message: 'A product order must contain an orderItem field'
            });

            return;
        }

        var asyncTasks = [];

        body.orderItem.forEach(function(item) {
           asyncTasks.push(completeRelatedPartyInfo.bind(this, item, req.user));
        });

        async.series(asyncTasks, function(err/*, results*/) {

            if (err) {
                callback(err);

            } else {

                // Include sellers as related party in the ordering

                var pushedSellers = [];

                body.orderItem.forEach(function(item) {

                    var sellers = item.product.relatedParty.filter(function(party) {
                        return party.role.toLowerCase() === SELLER.toLowerCase();
                    });

                    sellers.forEach(function(seller) {

                        if (pushedSellers.indexOf(seller.id) < 0) {
                            body.relatedParty.push(seller);
                            pushedSellers.push(seller.id);
                        }

                    });
                });

                req.body = JSON.stringify(body);

                callback();

            }
        });
    };


    //////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////// UPDATE ///////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////////////////////////////

    var calculateOrderingState = function(previousState, orderItems) {

        // STATES
        // Acknowledged - All the order items are acknowledged
        // In Progress - All the order items are Acknowledged or In Progress
        // Completed - All the order items are completed
        // Partial - There are order items completed or failed and also in progress
        // Failed - All failed
        // TODO: This will be implemented directly in the API. Once implemented, remove this part...

        var orderingState = previousState;
        var currentStates = { };
        currentStates[ACKNOWLEDGED.toLowerCase()] = 0;
        currentStates[IN_PROGRESS.toLowerCase()] = 0;
        currentStates[COMPLETED.toLowerCase()] = 0;
        currentStates[FAILED.toLowerCase()] = 0;

        orderItems.forEach(function(item) {
            currentStates[item['state'].toLowerCase()] += 1;
        });

        if (currentStates[ACKNOWLEDGED.toLowerCase()] === orderItems.length) {
            orderingState = ACKNOWLEDGED;
        } else if (currentStates[COMPLETED.toLowerCase()] === orderItems.length) {
            orderingState = COMPLETED;
        } else if (currentStates[FAILED.toLowerCase()] === orderItems.length) {
            orderingState = FAILED;
        } else {
            if (currentStates[COMPLETED.toLowerCase()] === 0 && currentStates[FAILED.toLowerCase()] === 0) {
                orderingState = IN_PROGRESS;
            } else {
                orderingState = PARTIAL;
            }
        }

        return orderingState;
    };

    var updateItemsState = function(req, updatedOrdering, previousOrdering, callback) {

        var error = null;

        for (var i = 0; i < updatedOrdering.orderItem.length && !error; i++) {

            var updatedItem = updatedOrdering.orderItem[i];
            var previousOrderItem = previousOrdering.orderItem.filter(function (item) {
                // id is supposed to be unique
                return item.id === updatedItem.id;
            })[0];

            if (!previousOrderItem) {

                error = {
                    status: 400,
                    message: 'You are trying to edit an non-existing item'
                };

            } else {

                var isSeller = tmfUtils.hasRole(previousOrderItem.product.relatedParty, SELLER, req.user);

                if (!isSeller) {

                    error = {
                        status: 403,
                        message: 'You cannot modify an order item if you are not seller'
                    };

                } else {

                    // Check that fields are not added or removed
                    if (Object.keys(updatedItem).length !== Object.keys(previousOrderItem).length) {
                        error = {
                            status: 403,
                            message: 'You cannot add or remove items to an order item'
                        }
                    }

                    // Check that the value of the fields is not changed (only state can be changed)
                    if (!error) {
                        for (var field in updatedItem) {

                            if (field.toLowerCase() !== 'state' && !equal(updatedItem[field], previousOrderItem[field])) {

                                error = {
                                    status: 403,
                                    message: 'The value of the field ' + field + ' cannot be changed'
                                };

                                break;
                            }
                        }
                    }

                    // If no errors, the state can be updated!
                    if (!error) {

                        if (previousOrderItem['state'] === ACKNOWLEDGED) {
                            error = {
                                status: 403,
                                message: 'Acknowledged order items cannot be updated manually'
                            }
                        } else {
                            previousOrderItem['state'] = updatedItem['state'];
                        }
                    }
                }
            }
        }

        if (!error) {

            // Sellers can only modify the 'orderItem' field...
            tmfUtils.updateBody(req, {
                state: calculateOrderingState(previousOrdering['state'], previousOrdering['orderItem']),
                orderItem: previousOrdering.orderItem
            });

            callback(null);

        } else {
            callback(error);
        }
    };

    var validateUpdate = function(req, callback) {

        var protocol = config.appSsl ? 'https' : 'http';
        var orderingServer = config.appHost + ':' + config.endpoints.ordering.port;
        var orderingUrl = protocol + '://' + orderingServer + req.apiPath;
        var ordering;

        try {

            ordering = JSON.parse(req.body);

            makeRequest(orderingUrl, 'The ordering cannot be retrieved', function(err, previousOrdering) {
                if (err) {
                    callback(err, res);
                } else {

                    var isSeller = tmfUtils.hasRole(previousOrdering.relatedParty, SELLER, req.user);
                    var isCustomer = tmfUtils.hasRole(previousOrdering.relatedParty, CUSTOMER, req.user);

                    if (isCustomer && !isSeller) {
                        // Customers cannot modify the status of the order items

                        if ('orderItem' in ordering || 'relatedParty' in ordering) {

                            callback({
                                status: 403,
                                message: 'The items of the ordering cannot be modified'
                            });

                        } else {
                            callback(null);
                        }

                    } else if (isSeller) {

                        if (Object.keys(ordering).length == 1 && 'orderItem' in ordering) {
                            updateItemsState(req, ordering, previousOrdering, callback);
                        } else {
                            callback({
                                status: 403,
                                message: 'As a seller, you can only modify the order items of the ordering'
                            });
                        }

                    } else {
                        callback({
                            status: 403,
                            message: 'You are not authorized to modify this ordering'
                        });
                    }
                }
            });

        } catch (e) {

            log.error(e);

            callback({
                status: 400,
                message: 'An expected error prevented the system from updating the ordering'
            });
        }
    };


    //////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// PRE-VALIDATION ///////////////////////////////////////
    //////////////////////////////////////////////////////////////////////////////////////////////

    var validators = {
        'GET': [ tmfUtils.validateLoggedIn, validateRetrieving ],
        'POST': [ tmfUtils.validateLoggedIn, validateCreation ],
        'PATCH': [ tmfUtils.validateLoggedIn, validateUpdate ],
        'PUT': [ tmfUtils.methodNotAllowed ],
        'DELETE': [ tmfUtils.methodNotAllowed ]
    };

    var checkPermissions = function (req, callback) {
        log.info('Checking Ordering permissions');

        var reqValidators = [];

        for (var i in validators[req.method]) {
            reqValidators.push(validators[req.method][i].bind(this, req));
        }

        async.series(reqValidators, callback);
    };


    //////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////// POST-VALIDATION //////////////////////////////////////
    //////////////////////////////////////////////////////////////////////////////////////////////

    var filterOrderItems = function(req, callback) {

        var body = JSON.parse(req.body);

        var orderings = [];
        var isArray = true;

        if (!Array.isArray(body)) {
            orderings = [body];
            isArray = false;
        } else {
            orderings = body;
        }

        orderings.forEach(function(ordering, i) {

            var customer = tmfUtils.hasRole(ordering.relatedParty, CUSTOMER, req.user);
            var seller = tmfUtils.hasRole(ordering.relatedParty, SELLER, req.user);

            if (!customer && !seller) {
                // This can happen when a user ask for a specific ordering.
                orderings.splice(i, 1);
            } else if (!customer && seller) {

                // When a user is involved only as a seller in an ordering, only the order items
                // where the user is a seller have to be returned

                ordering.orderItem = ordering.orderItem.filter(function(item) {
                    return tmfUtils.hasRole(item.product.relatedParty, SELLER, req.user);
                });
            }
            // ELSE: If the user is the customer, order items don't have to be filtered

        });

        if (!isArray) {

            if (orderings.length === 0) {
                callback({
                    status: 403,
                    message: 'You are not authorized to retrieve the specified ordering'
                });
            } else {
                tmfUtils.updateBody(req, orderings[0]);
            }

        } else {
            tmfUtils.updateBody(req, orderings);
        }

        callback(null);
    };

    var notifyOrder = function(req, callback) {

        log.info('Notifying ordering to the store');

        var body = JSON.parse(req.body);

        // Send ordering notification to the store
        storeClient.notifyOrder(body, req.user, function(err, res) {

            if (res) {

                log.info('The ordering has been notified to the store correctly');

                var parsedResp = JSON.parse(res.body);

                if (parsedResp.redirectUrl) {
                    req.headers['X-Redirect-URL'] = parsedResp.redirectUrl;
                }

                callback(null);

            } else {

                log.warn('There was a failure when notifying ordering to Store: ' + err.message);
                callback(err);
            }
        });
    };

    var executePostValidation = function(req, callback) {

        if (req.method === 'GET') {

            filterOrderItems(req, callback);

        } else if (req.method === 'POST') {

            notifyOrder(req, callback);

        } else {
            callback(null);
        }
    };


    //////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////// COMMON ///////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////////////////////////////

    return {
        checkPermissions: checkPermissions,
        executePostValidation: executePostValidation
    };

})();

exports.ordering = ordering;