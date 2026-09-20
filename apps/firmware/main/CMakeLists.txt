idf_component_register(SRCS "app_main.c"
                    INCLUDE_DIRS "."
                    PRIV_REQUIRES device_identity device_mqtt meter_telemetry provisioning relay_control)
