/**
 * @author Francisco de la Vega <fdelavega@conwet.com>
 *         Jaime Pajuelo <jpajuelo@conwet.com>
 *         Aitor Magán <amagan@conwet.com>
 */

(function () {

    'use strict';

    var LOADING = 'LOADING';
    var LOADED = 'LOADED';
    var ERROR = 'ERROR';

    angular
        .module('app')
        .controller('ProductSearchCtrl', ProductSearchController)
        .controller('ProductCreateCtrl', ProductCreateController)
        .controller('ProductUpdateCtrl', ProductUpdateController);

    function ProductSearchController($state, $rootScope, EVENTS, ProductSpec, LIFECYCLE_STATUS, Utils) {
        /* jshint validthis: true */
        var vm = this;

        vm.state = $state;

        vm.list = [];
        vm.list.flow = $state.params.flow;

        vm.showFilters = showFilters;

        ProductSpec.search($state.params).then(function (productList) {
            angular.copy(productList, vm.list);
            vm.list.status = LOADED;
        }, function (response) {
            vm.error = Utils.parseError(response, 'It was impossible to load the list of products');
            vm.list.status = ERROR;
        });

        function showFilters() {
            $rootScope.$broadcast(EVENTS.FILTERS_OPENED, LIFECYCLE_STATUS);
        }
    }

    function ProductCreateController($state, $rootScope, EVENTS, ProductSpec, Asset, AssetType, Utils) {
        /* jshint validthis: true */
        var vm = this;
        var stepList = [
            {
                title: 'General',
                templateUrl: 'stock/product/create/general'
            },
            {
                title: 'Bundle',
                templateUrl: 'stock/product/create/bundle'
            },
            {
                title: 'Assets',
                templateUrl: 'stock/product/create/assets'
            },
            {
                title: 'Characteristics',
                templateUrl: 'stock/product/create/characteristics'
            },
            {
                title: 'Attachments',
                templateUrl: 'stock/product/create/attachments'
            },
            {
                title: 'Party roles',
                templateUrl: 'stock/product/create/partyrole'
            },
            {
                title: 'Finish',
                templateUrl: 'stock/product/create/finish'
            }
        ];

        vm.data = ProductSpec.buildInitialData();
        vm.stepList = stepList;
        vm.assetTypes = [];
        vm.charList = [];
        vm.isDigital = false;
        vm.digitalChars = [];

        vm.create = create;
        vm.setCurrentType = setCurrentType;

        vm.toggleBundle = toggleBundle;

        vm.hasProduct = hasProduct;
        vm.toggleProduct = toggleProduct;

        vm.isSelected = isSelected;
        vm.saveCharacteristic = saveCharacteristic;
        vm.removeCharacteristic = removeCharacteristic;

        vm.roles = {
            provider: {
                value: "",
                items: []
            },
            customer: {
                value: "",
                items: []
            }
        };
        vm.appendRole = appendRole;
        vm.removeRole = removeRole;

        initChars();

        AssetType.search().then(function (typeList) {
            angular.copy(typeList, vm.assetTypes);

            if (typeList.length) {
                // Initialize digital asset characteristics
                vm.digitalChars.push(buildCharacteristic('Asset type', 'Type of the digital asset described in this product specification', ''));
                vm.digitalChars.push(buildCharacteristic('Media type', 'Media type of the digital asset described in this product specification', ''));
                vm.digitalChars.push(buildCharacteristic('Location', 'URL pointing to the digital asset described in this product specification', ''));
                vm.currentType = typeList[0];
                vm.currFormat = vm.currentType.formats[0];
                vm.digitalChars[0].productSpecCharacteristicValue[0].value = typeList[0].name;
            }
        });

        function removeCharacteristic(characteristic) {
            var index = vm.charList.indexOf(characteristic);

            if (index > -1) {
                vm.charList.splice(index, 1);
            }
        }

        function saveCharacteristic() {
            var newChar = vm.currentChar;

            // Clean fields that can contain invalid values due to hidden models
            if (newChar.valueType === 'string') {
                vm.currentValue.unitOfMeasure = '';
                vm.currentValue.valueFrom = '';
                vm.currentValue.valueTo = '';
            } else if (vm.currentValueType === 'value'){
                vm.currentValue.valueFrom = '';
                vm.currentValue.valueTo = '';
            } else {
                vm.currentValue.value = '';
            }

            newChar.productSpecCharacteristicValue = [vm.currentValue];
            vm.charList.push(newChar);
            initChars();
        }

        function initChars() {
            vm.currentChar = {
                valueType: 'string',
                configurable: false
            };
            vm.currentValueType = 'value';
            vm.currentValue = {
                default: true
            };
        }

        function isSelected(format) {
            return vm.currFormat === format;
        }

        function toggleProduct(product) {
            var index = vm.data.bundledProductSpecification.indexOf(product);

            if (index !== -1) {
                vm.data.bundledProductSpecification.splice(index, 1);
            } else {
                vm.data.bundledProductSpecification.push(product);
            }
        }

        function toggleBundle() {
            if (!vm.data.isBundle) {
                vm.data.bundledProductSpecification.length = 0;
            }
        }

        function hasProduct(product) {
            return vm.data.bundledProductSpecification.indexOf(product) !== -1;
        }

        function create() {
            // TODO: the party roles related to OnBoarding API are setting in:
            // vm.roles.customer.items <- Array of roles (String)
            // vm.roles.provider.items <- Array of roles (String)

            // If the format is file upload it to the asset manager
            if (vm.isDigital && vm.currFormat === 'FILE') {
                var reader = new FileReader();

                reader.onload = function(e) {
                    var data = {
                        content: {
                            name: vm.assetFile.name,
                            data: btoa(e.target.result)
                        },
                        contentType: vm.digitalChars[1].productSpecCharacteristicValue[0].value
                    };
                    Asset.create(data).then(function (result) {
                        // Set file location
                        vm.digitalChars[2].productSpecCharacteristicValue[0].value = result.content;
                        saveProduct();
                    });
                };
                reader.readAsBinaryString(vm.assetFile);
            } else {
                saveProduct();
            }
        }

        function buildCharacteristic(name, description, value) {
            return {
                name: name,
                description: description,
                valueType: 'string',
                configurable: false,
                validFor: {
                    startDateTime: "",
                    endDateTime: ""
                },
                productSpecCharacteristicValue: [
                    {
                        valueType: 'string',
                        default: true,
                        value: value,
                        unitOfMeasure: "",
                        valueFrom: "",
                        valueTo: "",
                        validFor: {
                            startDateTime: "",
                            endDateTime: ""
                        }
                    }
                ]
            };
        }

        function setCurrentType() {
            var i, found = false;
            var assetType = vm.digitalChars[0].productSpecCharacteristicValue[0].value;

            for (i = 0; i < vm.assetTypes.length && !found; i++) {

                if (assetType === vm.assetTypes[i].name) {
                    found = true;
                    vm.currentType = vm.assetTypes[i];
                }
            }
            vm.currFormat = vm.currentType.formats[0];
        }

        function saveProduct() {
            // Append product characteristics
            vm.data.productSpecCharacteristic = vm.charList;

            if (vm.isDigital) {
                vm.data.productSpecCharacteristic = vm.data.productSpecCharacteristic.concat(vm.digitalChars);
            }

            ProductSpec.create(vm.data).then(function (productCreated) {
                $state.go('stock.product.update', {
                    productId: productCreated.id
                });
                $rootScope.$broadcast(EVENTS.MESSAGE_ADDED, 'created', {
                    resource: 'product',
                    name: productCreated.name
                });
            }, function (response) {

                var defaultMessage = 'There was an unexpected error that prevented the ' +
                    'system from creating a new product';
                var error = Utils.parseError(response, defaultMessage);

                $rootScope.$broadcast(EVENTS.MESSAGE_ADDED, 'error', {
                    error: error
                });
            });
        }

        function appendRole(type) {
            var role = vm.roles[type].value;
            var index = vm.roles[type].items.indexOf(role);

            if (index === -1) {
                vm.roles[type].items.push(role);
            }

            vm.roles[type].value = "";
        }

        function removeRole(type, index) {
            vm.roles[type].items.splice(index, 1);
        }
    }

    function ProductUpdateController($state, $rootScope, EVENTS, ProductSpec, Utils) {
        /* jshint validthis: true */
        var vm = this;

        vm.$state = $state;
        vm.item = {};

        vm.update = update;
        vm.updateStatus = updateStatus;

        ProductSpec.detail($state.params.productId).then(function (productRetrieved) {
            vm.data = angular.copy(productRetrieved);
            vm.item = productRetrieved;
            vm.item.status = LOADED;
        }, function (response) {
            vm.error = Utils.parseError(response, 'The requested product could not be retrieved');
            vm.item.status = ERROR;
        });

        function updateStatus(status) {
            vm.data.lifecycleStatus = status;
            vm.statusUpdated = true;
        }

        function update() {
            ProductSpec.update(vm.data).then(function (productUpdated) {
                $state.go('stock.product.update', {
                    productId: productUpdated.id
                }, {
                    reload: true
                });
                $rootScope.$broadcast(EVENTS.MESSAGE_ADDED, 'updated', {
                    resource: 'product',
                    name: productUpdated.name
                });
            }, function (response) {

                var defaultMessage = 'There was an unexpected error that prevented the ' +
                    'system from updating the given product';
                var error = Utils.parseError(response, defaultMessage);

                $rootScope.$broadcast(EVENTS.MESSAGE_ADDED, 'error', {
                    error: error
                });
            });
        }
    }

})();
