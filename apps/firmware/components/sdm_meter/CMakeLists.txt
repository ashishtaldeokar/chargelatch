idf_component_register(SRCS "sdm_meter.c" "sdm_modbus.c" "sdm_registers.c" "sdm_json.c"
                    INCLUDE_DIRS "include"
                    PRIV_REQUIRES driver)
