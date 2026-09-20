idf_component_register(SRCS "relay_control.c" "relay_remote.c"
                    INCLUDE_DIRS "include"
                    PRIV_REQUIRES driver nvs_flash json device_mqtt)
