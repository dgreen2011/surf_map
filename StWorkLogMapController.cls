/***********************************************************************************************
 * Copyright (c) 2025 Sitetracker
 * This code is the sole property of Sitetracker and may not be distributed
 * or modified without prior written consent from an authorized representative
 * from Sitetracker.
 * All rights reserved.
 *
 * This class is the controller for the StWorkLogMap page
 *
 ************************************************************************************************/

public with sharing class StWorkLogMapController {
    public String workLogId { get; set; }
    private String geoDataJSONValue;

    public class MapInitResponse {
        @AuraEnabled public String geoDataJson { get; set; }
        @AuraEnabled public String mapProviderName { get; set; }
        @AuraEnabled public String mapProviderUrl { get; set; }
        @AuraEnabled public String errorMessage { get; set; }
    }

    public String getGeoDataJSON() {
        return geoDataJSONValue;
    }

    public StWorkLogMapController() {
        workLogId = ApexPages.currentPage().getParameters().get('id');

        if (String.isNotBlank(workLogId)) {
            loadGeoData();
        } else {
            StLog.warn(StWorkLogMapController.class, 'No workLogId parameter provided in URL');
        }
    }

    @AuraEnabled(cacheable=true)
    public static MapInitResponse getMapInitData(Id workLogId) {
        MapInitResponse response = new MapInitResponse();
        response.mapProviderName = getMapProviderNameInternal();
        response.mapProviderUrl = getMapProviderUrlInternal();

        if (workLogId == null) {
            response.errorMessage = 'No work log id was provided.';
            response.geoDataJson = JSON.serialize(
                new Map<String, Object>{ 'error' => response.errorMessage }
            );
            return response;
        }

        try {
            Map<String, Object> geoData = buildGeoData(workLogId);
            response.geoDataJson = JSON.serialize(geoData);
        } catch (Exception e) {
            StLog.error(
                StWorkLogMapController.class,
                'Error loading geo data for workLogId: ' + String.valueOf(workLogId),
                e
            );
            response.errorMessage = e.getMessage();
            response.geoDataJson = JSON.serialize(
                new Map<String, Object>{ 'error' => response.errorMessage }
            );
        }

        return response;
    }

    private void loadGeoData() {
        try {
            Map<String, Object> geoData = buildGeoData((Id) workLogId);
            geoDataJSONValue = JSON.serialize(geoData);
        } catch (Exception e) {
            StLog.error(
                StWorkLogMapController.class,
                'Error loading geo data for workLogId: ' + workLogId,
                e
            );
            geoDataJSONValue = JSON.serialize(
                new Map<String, Object>{ 'error' => e.getMessage() }
            );
        }
    }

    private static Map<String, Object> buildGeoData(Id workLogId) {
        Production_Work_Log__c workLog = [
            SELECT
                Id,
                Segment__c,
                st_Area__c,
                Site__c,
                st_GIS_Path__c,
                Location__Latitude__s,
                Location__Longitude__s
            FROM Production_Work_Log__c
            WHERE Id = :workLogId
            WITH SECURITY_ENFORCED
            LIMIT 1
        ];

        Map<String, Object> geoData = new Map<String, Object>();

        if (String.isNotBlank(workLog.st_GIS_Path__c)) {
            if (workLog.Segment__c != null) {
                geoData.put('type', 'segment');
                geoData.put('geometry', 'LineString');
            } else if (workLog.st_Area__c != null) {
                geoData.put('type', 'area');
                geoData.put('geometry', 'Polygon');
            }

            geoData.put('gisPath', workLog.st_GIS_Path__c);
        } else if (workLog.Location__Latitude__s != null && workLog.Location__Longitude__s != null) {
            geoData.put('type', 'site');
            geoData.put('latitude', workLog.Location__Latitude__s);
            geoData.put('longitude', workLog.Location__Longitude__s);
            geoData.put('geometry', 'Point');
        }

        return geoData;
    }

    public String getMapProviderName() {
        return getMapProviderNameInternal();
    }

    public String getMapProviderUrl() {
        return getMapProviderUrlInternal();
    }

    private static String getMapProviderNameInternal() {
        return 'mapbox';
    }

    private static String getMapProviderUrlInternal() {
        return 'https://api.mapbox.com/mapbox-gl-js/' + StAppConfig.MAPBOX_VERSION + '/mapbox-gl.js';
    }
}
