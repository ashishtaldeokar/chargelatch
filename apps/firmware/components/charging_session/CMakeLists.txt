idf_component_register(SRCS "charging_session.c"
                    INCLUDE_DIRS "include"
                    REQUIRES sdm_meter
                    PRIV_REQUIRES device_mqtt relay_control nvs_flash json)
