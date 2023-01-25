Auto Relocking ECDL by Redpitaya
=======================================

This project is for automatically relocking the External Cavity Diode Lasers (ECDLs) 
by wavemeter and/or cavity transmission using Red Pitaya.

.. image:: doc/img/AutoRelockingRydbergLaser.png
  :width: 1000
  :alt: Schematic diagram of the project


Where we can Use this Web Application
###########################

* Manual Mode

  * Controlling Piezo Voltage of the Laser Driver
  * Controlling Current Voltage of the Laser Driver
  * Monitoring Wavemeter
  * Monitoring Cavity Transmission

* Automatic Mode

  * Relocking ECDLs only by Cavity Transmission
  * Relocking ECDLs only by Wavemeter
  * Relocking ECDLs by Cavity Transmission and/or Wavemeter
  * Relocking Transfer Cavity by DigiLock
  * Monitoring Wavemeter
  * Monitoring Cavity Transmission

.. note::

    If you want to use Wavemeter or DigiLock, Server should be running on the Wavemeter's PC


Server on the Wavemeter's PC
###########################
Server have to be run on the PC which the Wavemeter is connected on

.. note::

    For downlaoding the server application click on `Wavemeter API Server`_.

.. _Wavemeter API Server: https://github.com/mehrdadzarei/Wavemeter_API_Server_by_Python
    



