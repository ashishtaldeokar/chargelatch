idf_component_register(SRCS "meter_telemetry.c"
                    INCLUDE_DIRS "include"
                    REQUIRES sdm_meter
                    PRIV_REQUIRES device_mqtt charging_session)
