set(AIARCH_AID_SRC
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/aid/sse.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../services/aid/gateway.cpp
)

add_executable(t_config t_config.cpp)
target_link_libraries(t_config PRIVATE aiarch-common Qt6::Test)
add_test(NAME t_config COMMAND t_config)

add_executable(t_sse t_sse.cpp ${CMAKE_CURRENT_SOURCE_DIR}/../services/aid/sse.cpp)
target_include_directories(t_sse PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../services/aid)
target_link_libraries(t_sse PRIVATE aiarch-common Qt6::Test)
add_test(NAME t_sse COMMAND t_sse)

add_executable(t_secretstore t_secretstore.cpp)
target_link_libraries(t_secretstore PRIVATE aiarch-common Qt6::Test)
add_test(NAME t_secretstore COMMAND t_secretstore)

add_executable(t_gateway t_gateway.cpp ${AIARCH_AID_SRC})
target_include_directories(t_gateway PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../services/aid)
target_link_libraries(t_gateway PRIVATE aiarch-common Qt6::Test Qt6::Network)
add_test(NAME t_gateway COMMAND t_gateway)
set_tests_properties(t_gateway PROPERTIES
    WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
    ENVIRONMENT "AIARCH_DATA_DIR=${CMAKE_CURRENT_BINARY_DIR}/tdata")
