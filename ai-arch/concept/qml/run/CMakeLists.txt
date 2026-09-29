cmake_minimum_required(VERSION 3.16)
project(aiarch-concept-runner LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Gui Qml Quick)

add_executable(runner runner.cpp)
target_link_libraries(runner PRIVATE Qt6::Gui Qt6::Qml Qt6::Quick)
