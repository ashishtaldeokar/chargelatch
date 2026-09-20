idf_component_register(SRCS "meter_telemetry.c"
                    INCLUDE_DIRS "include"
                    PRIV_REQUIRES sdm_meter device_mqtt)
